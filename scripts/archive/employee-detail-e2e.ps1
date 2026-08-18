# End-to-end API tests for the Employee Detail / Edit / Multi-Project flow.
#
# Covers:
#   GET  /api/employees/:id/detail           (org+dept in payload, no secrets)
#   PUT  /api/employees/:id                  (validation, 404/409/422, audit)
#   GET  /api/employees/:id/projects         (memberships + project info)
#   PUT  /api/employees/:id/projects         (assign/replace/soft-remove)
#   GET  /api/projects/search                (combobox search + ids hydration)
#
# Test data (real DB, discovered via API):
#   Sarah Chen  EMP-001  — has active project assignments
#   Michael Brown EMP-004 — has NO project assignments (state restored at end)
#
# Reads credentials from .env (never printed).
$ErrorActionPreference = 'Stop'

function Get-EnvVar($name) {
  $line = (Get-Content "$PSScriptRoot\..\.env" | Where-Object { $_ -match "^$name=" } | Select-Object -First 1)
  if (-not $line) { throw "Missing $name in .env" }
  return $line.Substring($name.Length + 1)
}

$email = Get-EnvVar 'SUPER_ADMIN_EMAIL'
$password = Get-EnvVar 'SUPER_ADMIN_PASSWORD'
$base = 'http://localhost:3000'

# ── Login ──────────────────────────────────────────────────────────────────
$loginBody = @{ email = $email; password = $password } | ConvertTo-Json
$loginRes = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -Body $loginBody -ContentType 'application/json' -SessionVariable webSession
Write-Host "LOGIN: OK ($($loginRes.user.email), role=$($loginRes.user.role))"

$pass = 0; $fail = 0
function Assert([string]$name, [bool]$cond, [string]$detail = '') {
  if ($cond) { $script:pass++; Write-Host "  PASS  $name" }
  else { $script:fail++; Write-Host "  FAIL  $name  $detail" }
}

function Invoke-Api([string]$method, [string]$path, $body = $null) {
  $params = @{ Uri = "$base$path"; Method = $method; WebSession = $webSession }
  if ($null -ne $body) {
    $params.Body = ($body | ConvertTo-Json -Depth 10)
    $params.ContentType = 'application/json'
  }
  return Invoke-RestMethod @params
}

# ── Discover real test employees ───────────────────────────────────────────
$sarah = Invoke-Api 'GET' '/api/employees/search?q=EMP-001'
Assert 'discover Sarah Chen (EMP-001)' ($sarah.data.Count -eq 1 -and $sarah.data[0].firstName -eq 'Sarah')
$sarahId = $sarah.data[0].id
$sarahFull = Invoke-Api 'GET' "/api/employees/$sarahId/detail"
$sarahEmp = $sarahFull.employee
Assert 'detail payload has organization' ($null -ne $sarahEmp.organization -and $sarahEmp.organization.name -eq 'TechVision Global')
Assert 'detail payload has organizationId' (-not [string]::IsNullOrEmpty($sarahEmp.organizationId))
Assert 'detail payload has departmentId' (-not [string]::IsNullOrEmpty($sarahEmp.departmentId))
Assert 'detail payload has employeeId EMP-001' ($sarahEmp.employeeId -eq 'EMP-001')
Assert 'detail payload leaks NO agentPassword' (-not ($sarahFull | ConvertTo-Json -Depth 10).Contains('agentPassword'))

$michael = Invoke-Api 'GET' '/api/employees/search?q=EMP-004'
Assert 'discover Michael Brown (EMP-004)' ($michael.data.Count -eq 1 -and $michael.data[0].firstName -eq 'Michael')
$michaelId = $michael.data[0].id

# ── Baseline project state ─────────────────────────────────────────────────
$mProj0 = Invoke-Api 'GET' "/api/employees/$michaelId/projects"
Assert 'Michael starts with 0 active projects' (($mProj0.data | Where-Object { $null -eq $_.leftAt }).Count -eq 0)
$sProj0 = Invoke-Api 'GET' "/api/employees/$sarahId/projects"
$sarahActive = @($sProj0.data | Where-Object { $null -eq $_.leftAt })
Assert 'Sarah has >= 1 active project' ($sarahActive.Count -ge 1) "got $($sarahActive.Count)"
Assert 'Sarah membership has project name' (-not [string]::IsNullOrEmpty($sarahActive[0].project.name))
Assert 'Sarah membership has role + joinedAt' ($null -ne $sarahActive[0].role -and $null -ne $sarahActive[0].joinedAt)
Assert 'Sarah membership has project status' (-not [string]::IsNullOrEmpty($sarahActive[0].project.status))
try {
  Invoke-RestMethod -Uri "$base/api/employees/cmsj00000000nonexistent000/projects" -WebSession $webSession | Out-Null
  Assert 'GET projects nonexistent employee -> 404' $false 'no error thrown'
} catch {
  Assert 'GET projects nonexistent employee -> 404' ($_.Exception.Response.StatusCode.value__ -eq 404) "got $($_.Exception.Response.StatusCode.value__)"
}

# ── Projects search endpoint ───────────────────────────────────────────────
$ps = Invoke-Api 'GET' '/api/projects/search?q=Website+Redesign'
Assert 'project search finds Website Redesign' ($ps.total -ge 1 -and $ps.data[0].name -eq 'Website Redesign')
$psAll = Invoke-Api 'GET' '/api/projects/search?limit=50'
Assert 'project search default lists all 10' ($psAll.total -eq 10) "got $($psAll.total)"
Assert 'project search minimal fields only' (($psAll.data[0].PSObject.Properties.Name -join ',') -eq 'id,name,status,priority,color,startDate,deadline,departmentName')
$psId = Invoke-Api 'GET' "/api/projects/search?ids=$($sarahActive[0].projectId)"
Assert 'project search ids hydration' ($psId.total -eq 1 -and $psId.data[0].id -eq $sarahActive[0].projectId)
try {
  Invoke-RestMethod -Uri "$base/api/projects/search?limit=0" -WebSession $webSession | Out-Null
  Assert 'project search limit=0 rejected' $false 'no error thrown'
} catch {
  Assert 'project search limit=0 rejected' ($_.Exception.Response.StatusCode.value__ -eq 400) "got $($_.Exception.Response.StatusCode.value__)"
}

# ── PUT /api/employees/:id — validation ────────────────────────────────────
function Expect-Status([string]$name, [string]$path, $body, [int]$status) {
  try {
    Invoke-Api 'PUT' $path $body | Out-Null
    Assert $name $false 'no error thrown'
  } catch {
    Assert $name ($_.Exception.Response.StatusCode.value__ -eq $status) "got $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)"
  }
}

$validBody = @{
  firstName = 'Sarah'; lastName = 'Chen'; email = 'sarah.chen@techvision.com'
  phone = $sarahEmp.phone; designation = $sarahEmp.designation
  departmentId = $sarahEmp.departmentId; status = 'active'
}

Expect-Status 'PUT missing firstName -> 400' "/api/employees/$sarahId" (@{ lastName = 'X'; email = 'a@b.com'; status = 'active' }) 400
Expect-Status 'PUT invalid email -> 400' "/api/employees/$sarahId" (@{ firstName = 'A'; lastName = 'B'; email = 'not-an-email'; status = 'active' }) 400
Expect-Status 'PUT invalid status -> 400' "/api/employees/$sarahId" (@{ firstName = 'A'; lastName = 'B'; email = 'a@b.com'; status = 'bogus' }) 400
Expect-Status 'PUT nonexistent employee -> 404' '/api/employees/cmsj00000000nonexistent000' $validBody 404
Expect-Status 'PUT cross-org department -> 422' "/api/employees/$sarahId" (@{ firstName = 'A'; lastName = 'B'; email = 'a@b.com'; departmentId = 'cmsj00000000nonexistent000'; status = 'active' }) 422

# Duplicate email within org (Marcus Reed EMP-039 uses techvision email)
$marcus = Invoke-Api 'GET' '/api/employees/search?q=EMP-039'
$dupBody = @{ firstName = 'Sarah'; lastName = 'Chen'; email = $marcus.data[0].email; departmentId = $null; status = 'active' }
Expect-Status 'PUT duplicate email -> 409' "/api/employees/$sarahId" $dupBody 409

# ── PUT /api/employees/:id — happy path + persistence ──────────────────────
$origDesignation = $sarahEmp.designation
$updated = Invoke-Api 'PUT' "/api/employees/$sarahId" (@{
  firstName = 'Sarah'; lastName = 'Chen'; email = 'sarah.chen@techvision.com'
  phone = $sarahEmp.phone; designation = 'QA Engineer (e2e)'
  departmentId = $sarahEmp.departmentId; status = 'active'; joinDate = $null
})
Assert 'PUT updates designation' ($updated.data.designation -eq 'QA Engineer (e2e)')
$reRead = Invoke-Api 'GET' "/api/employees/$sarahId/detail"
Assert 'designation persisted in DB' ($reRead.employee.designation -eq 'QA Engineer (e2e)')

$updated2 = Invoke-Api 'PUT' "/api/employees/$sarahId" (@{
  firstName = 'Sarah'; lastName = 'Chen'; email = 'sarah.chen@techvision.com'
  phone = $sarahEmp.phone; designation = 'QA Engineer (e2e)'
  departmentId = $sarahEmp.departmentId; status = 'inactive'; joinDate = $null
})
Assert 'PUT changes status to inactive' ($updated2.data.status -eq 'inactive')
$reRead2 = Invoke-Api 'GET' "/api/employees/$sarahId/detail"
Assert 'status persisted in DB' ($reRead2.employee.status -eq 'inactive')

# Restore Sarah (designation + status) — leave DB as found
Invoke-Api 'PUT' "/api/employees/$sarahId" (@{
  firstName = 'Sarah'; lastName = 'Chen'; email = 'sarah.chen@techvision.com'
  phone = $sarahEmp.phone; designation = $origDesignation
  departmentId = $sarahEmp.departmentId; status = 'active'; joinDate = $null
}) | Out-Null
$restored = Invoke-Api 'GET' "/api/employees/$sarahId/detail"
Assert 'Sarah restored to original state' ($restored.employee.designation -eq $origDesignation -and $restored.employee.status -eq 'active')

# ── PUT /api/employees/:id/projects — assignment lifecycle ─────────────────
$projList = Invoke-Api 'GET' '/api/projects/search?limit=50'
$p1 = $projList.data[0].id   # Website Redesign
$p2 = $projList.data[1].id   # Mobile App Development

# 1. Assign two projects
$r1 = Invoke-Api 'PUT' "/api/employees/$michaelId/projects" @{ projectIds = @($p1, $p2) }
Assert 'assign 2 projects -> added 2' ($r1.data.added -eq 2) "got $($r1.data.added)"
$m1 = Invoke-Api 'GET' "/api/employees/$michaelId/projects"
$m1Active = @($m1.data | Where-Object { $null -eq $_.leftAt })
Assert 'Michael now has 2 active projects' ($m1Active.Count -eq 2) "got $($m1Active.Count)"

# 2. Re-assign the same 2 (idempotent, no duplicates possible)
$r2 = Invoke-Api 'PUT' "/api/employees/$michaelId/projects" @{ projectIds = @($p1, $p2) }
Assert 're-assign same 2 -> added 0' ($r2.data.added -eq 0) "got $($r2.data.added)"
$m2 = Invoke-Api 'GET' "/api/employees/$michaelId/projects"
Assert 'no duplicate memberships after re-assign' (@($m2.data | Where-Object { $null -eq $_.leftAt }).Count -eq 2)

# 3. Remove one project (replace with only p1)
$r3 = Invoke-Api 'PUT' "/api/employees/$michaelId/projects" @{ projectIds = @($p1) }
Assert 'remove 1 project -> removed 1' ($r3.data.removed -eq 1) "got $($r3.data.removed)"
$m3 = Invoke-Api 'GET' "/api/employees/$michaelId/projects"
$m3Active = @($m3.data | Where-Object { $null -eq $_.leftAt })
$m3Past = @($m3.data | Where-Object { $null -ne $_.leftAt })
Assert '1 active project remains' ($m3Active.Count -eq 1 -and $m3Active[0].projectId -eq $p1)
Assert 'removed project moved to past (leftAt set, not deleted)' ($m3Past.Count -eq 1 -and $null -ne $m3Past[0].leftAt)

# 4. Remove all projects
$r4 = Invoke-Api 'PUT' "/api/employees/$michaelId/projects" @{ projectIds = @() }
Assert 'empty projectIds -> removed 1' ($r4.data.removed -eq 1) "got $($r4.data.removed)"
$m4 = Invoke-Api 'GET' "/api/employees/$michaelId/projects"
Assert 'Michael back to 0 active projects' (@($m4.data | Where-Object { $null -eq $_.leftAt }).Count -eq 0)

# 5. Validation + auth
Expect-Status 'PUT projects missing array -> 400' "/api/employees/$michaelId/projects" @{} 400
Expect-Status 'PUT projects bogus project -> 422' "/api/employees/$michaelId/projects" @{ projectIds = @('cmsj00000000nonexistent000') } 422
Expect-Status 'PUT projects nonexistent employee -> 404' '/api/employees/cmsj00000000nonexistent000/projects' @{ projectIds = @() } 404
try {
  Invoke-RestMethod -Uri "$base/api/employees/$michaelId/projects" -Method Put -Body (@{ projectIds = @($p1) } | ConvertTo-Json) -ContentType 'application/json' -UseBasicParsing | Out-Null
  Assert 'PUT projects no session -> 401' $false 'no error thrown'
} catch {
  Assert 'PUT projects no session -> 401' ($_.Exception.Response.StatusCode.value__ -eq 401) "got $($_.Exception.Response.StatusCode.value__)"
}

# ── Audit logging ──────────────────────────────────────────────────────────
$audit = Invoke-Api 'GET' '/api/audit-logs?pageSize=50'
$auditJson = $audit | ConvertTo-Json -Depth 10
Assert 'audit log has project assignment entry' ($auditJson.Contains('Assigned Michael Brown'))
Assert 'audit log has project removal entry' ($auditJson.Contains('Removed Michael Brown'))
Assert 'audit log has employee update entry' ($auditJson.Contains('Updated employee Sarah Chen'))

Write-Host ""
Write-Host "RESULT: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
