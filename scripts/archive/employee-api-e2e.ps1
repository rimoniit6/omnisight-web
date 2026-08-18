# End-to-end API tests for the extended /api/employees endpoint.
# Reads credentials from .env (never printed), logs in, exercises filters.
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

function Get-Employees([string]$qs) {
  return Invoke-RestMethod -Uri "$base/api/employees?$qs" -WebSession $webSession
}

$pass = 0; $fail = 0
function Assert([string]$name, [bool]$cond, [string]$detail = '') {
  if ($cond) { $script:pass++; Write-Host "  PASS  $name" }
  else { $script:fail++; Write-Host "  FAIL  $name  $detail" }
}

# ── Pagination & response shape ────────────────────────────────────────────
$r = Get-Employees 'page=1&pageSize=20'
Assert 'default page=1, pageSize=20' ($r.page -eq 1 -and $r.pageSize -eq 20)
Assert 'default total=40 (41 - 1 archived)' ($r.total -eq 40) "got $($r.total)"
Assert '20 rows on page 1' ($r.data.Count -eq 20)
Assert 'pagination object present' ($r.pagination.page -eq 2 -or $r.pagination.page -eq 1 -and $null -ne $r.pagination.totalPages -and $r.pagination.total -eq 40)
Assert 'totalPages=2 (40/20)' ($r.pagination.totalPages -eq 2)
Assert 'agentPassword NOT leaked' (-not ($r.data | ConvertTo-Json -Depth 5).Contains('agentPassword'))

$r2 = Get-Employees 'page=2&pageSize=20'
Assert 'page 2 has 20 rows' ($r2.data.Count -eq 20)
$ids1 = (($r.data | ForEach-Object { $_.id }) -join ',')
$ids2 = (($r2.data | ForEach-Object { $_.id }) -join ',')
Assert 'page 2 ids differ from page 1' ($ids1 -ne $ids2)

$r50 = Get-Employees 'pageSize=50'
Assert 'pageSize=50 returns all 40' ($r50.data.Count -eq 40)

# ── Search ─────────────────────────────────────────────────────────────────
$s = Get-Employees 'search=rimon'
Assert 'search first name (rimon)' ($s.total -eq 1 -and $s.data[0].firstName -eq 'Rimon')
$s = Get-Employees 'search=cooper'
Assert 'search last name (cooper, archived hidden by default)' ($s.total -eq 0)
$s = Get-Employees 'search=cooper&status=archived'
Assert 'search last name + status=archived' ($s.total -eq 1 -and $s.data[0].lastName -eq 'Cooper')
$s = Get-Employees 'search=EMP-040'
Assert 'search employee id (EMP-040, archived hidden by default)' ($s.total -eq 0)
$s = Get-Employees 'search=EMP-040&status=archived'
Assert 'search employee id with status=archived' ($s.total -eq 1)
$s = Get-Employees 'search=mdrimonrana@gmail.com'
Assert 'search email' ($s.total -ge 1)
$s = Get-Employees 'search=a%26b'   # special chars must not error
Assert 'special chars in search do not error' ($null -ne $s)

# ── Status filter ──────────────────────────────────────────────────────────
Assert 'status=active -> 37' ((Get-Employees 'status=active').total -eq 37)
Assert 'status=inactive -> 3' ((Get-Employees 'status=inactive').total -eq 3)
Assert 'status=archived -> 1' ((Get-Employees 'status=archived').total -eq 1)
try { Get-Employees 'status=pending' | Out-Null; Assert 'status=pending rejected' $false 'no error' }
catch { Assert 'status=pending rejected' ($_.Exception.Response.StatusCode.value__ -eq 400) "got $($_.Exception.Response.StatusCode.value__)" }

# ── Department filter ──────────────────────────────────────────────────────
$engId = 'cmsj1283a000aqbos5q5c7lkl'
$dept = Get-Employees "departmentId=$engId"
$engCount = $dept.total
Assert 'departmentId=Engineering returns >0' ($engCount -gt 0)
Assert 'every row in Engineering dept' (($dept.data | Where-Object { $_.department.id -ne $engId }).Count -eq 0)
try { Get-Employees 'departmentId=nonexistent' | Out-Null; Assert 'invalid departmentId rejected' $false 'no error' }
catch { Assert 'invalid departmentId rejected' ($_.Exception.Response.StatusCode.value__ -eq 400) }

# ── Role filter (department managers) ──────────────────────────────────────
Assert 'role=manager -> 9' ((Get-Employees 'role=manager').total -eq 9)
$nonManagers = (Get-Employees 'role=employee').total
Assert 'role=employee -> total - 9' ($nonManagers -eq 40 - 9) "got $nonManagers"
try { Get-Employees 'role=ceo' | Out-Null; Assert 'invalid role rejected' $false }
catch { Assert 'invalid role rejected' ($_.Exception.Response.StatusCode.value__ -eq 400) }

# ── Device status filter ───────────────────────────────────────────────────
$online = (Get-Employees 'deviceStatus=online').total
Assert 'deviceStatus=online >0' ($online -gt 0)
$offline = (Get-Employees 'deviceStatus=offline').total
$noDevice = (Get-Employees 'deviceStatus=no_device').total
Write-Host "  INFO  online=$online offline=$offline noDevice=$noDevice (sum=$($online+$offline+$noDevice), total=40)"
Assert 'device buckets partition employees' (($online + $offline + $noDevice) -eq 40)

# ── Date range filter ──────────────────────────────────────────────────────
$day = Get-Employees 'createdFrom=2026-08-07&createdTo=2026-08-07'
Assert 'created 2026-08-07 range' ($day.total -ge 1) "got $($day.total)"
Assert 'all rows within range' (($day.data | Where-Object { [datetime]$_.createdAt -lt [datetime]'2026-08-07' -or [datetime]$_.createdAt -ge [datetime]'2026-08-08' }).Count -eq 0)
try { Get-Employees 'createdFrom=not-a-date' | Out-Null; Assert 'invalid date rejected' $false }
catch { Assert 'invalid date rejected' ($_.Exception.Response.StatusCode.value__ -eq 400) }
try { Get-Employees 'createdFrom=2026-13-45' | Out-Null; Assert 'impossible date rejected' $false }
catch { Assert 'impossible date rejected' ($_.Exception.Response.StatusCode.value__ -eq 400) }

# ── Sorting ────────────────────────────────────────────────────────────────
$nameAsc = Get-Employees 'sortBy=name&sortOrder=asc&pageSize=50'
$names = $nameAsc.data | ForEach-Object { "$($_.firstName) $($_.lastName)" }
Assert 'sortBy=name asc' (($names -join '|') -eq (($names | Sort-Object) -join '|'))
$emailDesc = Get-Employees 'sortBy=email&sortOrder=desc&pageSize=50'
$emails = $emailDesc.data | ForEach-Object { $_.email }
Assert 'sortBy=email desc' (($emails -join '|') -eq (($emails | Sort-Object -Descending) -join '|'))
$created = Get-Employees 'sortBy=createdAt&sortOrder=asc&pageSize=50'
$createdDates = $created.data | ForEach-Object { [datetime]$_.createdAt }
Assert 'sortBy=createdAt asc' (($createdDates -join '|') -eq (($createdDates | Sort-Object) -join '|'))
$deptSort = Get-Employees 'sortBy=department.name&sortOrder=desc&pageSize=50'
$deptNames = $deptSort.data | ForEach-Object { $_.department.name }
Assert 'sortBy=department.name desc' (($deptNames -join '|') -eq (($deptNames | Sort-Object -Descending) -join '|'))
try { Get-Employees 'sortBy=banana' | Out-Null; Assert 'invalid sortBy rejected' $false }
catch { Assert 'invalid sortBy rejected' ($_.Exception.Response.StatusCode.value__ -eq 400) }
try { Get-Employees 'sortOrder=sideways' | Out-Null; Assert 'invalid sortOrder rejected' $false }
catch { Assert 'invalid sortOrder rejected' ($_.Exception.Response.StatusCode.value__ -eq 400) }

# ── Combined filters ───────────────────────────────────────────────────────
$comb = Get-Employees 'search=kevin&status=active&role=manager&page=1&pageSize=20&sortBy=name&sortOrder=asc'
Assert 'combined search+status+role' ($comb.total -eq 1 -and $comb.data[0].firstName -eq 'Kevin')

# ── Invalid pagination ─────────────────────────────────────────────────────
try { Get-Employees 'page=abc' | Out-Null; Assert 'page=abc rejected' $false }
catch { Assert 'page=abc rejected' ($_.Exception.Response.StatusCode.value__ -eq 400) }
try { Get-Employees 'pageSize=0' | Out-Null; Assert 'pageSize=0 rejected' $false }
catch { Assert 'pageSize=0 rejected' ($_.Exception.Response.StatusCode.value__ -eq 400) }
try { Get-Employees 'pageSize=99999' | Out-Null; Assert 'pageSize=99999 rejected' $false }
catch { Assert 'pageSize=99999 rejected' ($_.Exception.Response.StatusCode.value__ -eq 400) }
$beyond = Get-Employees 'page=999'
Assert 'page beyond range -> empty data, valid pagination' ($beyond.data.Count -eq 0 -and $beyond.pagination.totalPages -eq 2)

# ── Legacy param compatibility ─────────────────────────────────────────────
$legacy = Get-Employees 'limit=100'
Assert 'limit alias works' ($legacy.data.Count -eq 40)

# ── Organizations endpoint ─────────────────────────────────────────────────
$orgs = Invoke-RestMethod -Uri "$base/api/organizations" -WebSession $webSession
Assert 'organizations endpoint lists org' ($orgs.data.Count -ge 1 -and $orgs.data[0].name -eq 'TechVision Global')

# ── Auth guard ─────────────────────────────────────────────────────────────
try {
  Invoke-RestMethod -Uri "$base/api/employees" -Method Get | Out-Null
  Assert 'no session -> 401' $false 'no error'
} catch {
  Assert 'no session -> 401' ($_.Exception.Response.StatusCode.value__ -eq 401)
}

Write-Host ""
Write-Host "RESULT: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
