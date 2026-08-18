# End-to-end API tests for the lightweight employee search endpoint
# (GET /api/employees/search) used by EmployeeCombobox.
# Reads credentials from .env (never printed), logs in, exercises search.
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

function Search([string]$qs) {
  return Invoke-RestMethod -Uri "$base/api/employees/search?$qs" -WebSession $webSession
}

$pass = 0; $fail = 0
function Assert([string]$name, [bool]$cond, [string]$detail = '') {
  if ($cond) { $script:pass++; Write-Host "  PASS  $name" }
  else { $script:fail++; Write-Host "  FAIL  $name  $detail" }
}

# ── Response shape & minimal fields ────────────────────────────────────────
$r = Search 'limit=5'
Assert 'default list returns 5 rows' ($r.data.Count -eq 5) "got $($r.data.Count)"
Assert 'total counts non-archived employees (40)' ($r.total -eq 40) "got $($r.total)"
Assert 'pagination meta present' ($r.limit -eq 5 -and $r.offset -eq 0)
Assert 'only selection fields returned' ($r.data[0].PSObject.Properties.Name -join ',' -eq 'id,employeeId,firstName,lastName,email,designation,avatar,departmentName')
Assert 'agentPassword NOT leaked' (-not ($r.data | ConvertTo-Json -Depth 5).Contains('agentPassword'))
Assert 'no phone/status/joinDate leaked' (-not ($r.data | ConvertTo-Json -Depth 5).Contains('joinDate'))

# ── Initial list (no query) ────────────────────────────────────────────────
$r20 = Search ''
Assert 'default limit=20' ($r20.data.Count -eq 20) "got $($r20.data.Count)"
Assert 'default total=40' ($r20.total -eq 40)
$r50 = Search 'limit=50'
Assert 'limit=50 returns all 40' ($r50.data.Count -eq 40) "got $($r50.data.Count)"

# ── Search by name / partial / case ────────────────────────────────────────
$s = Search 'q=rimon'
Assert 'q=rimon -> 1 (Rimon Rana)' ($s.total -eq 1 -and $s.data[0].firstName -eq 'Rimon' -and $s.data[0].lastName -eq 'Rana') "got $($s.total)"
$s = Search 'q=RIMON'
Assert 'q=RIMON (uppercase, case-insensitive)' ($s.total -eq 1 -and $s.data[0].firstName -eq 'Rimon') "got $($s.total)"
$s = Search 'q=Rimon+Ra'
Assert 'q=Rimon Ra (multi-word tokens)' ($s.total -eq 1 -and $s.data[0].lastName -eq 'Rana') "got $($s.total)"
$s = Search 'q=ana'
Assert 'q=ana (partial substring match)' ($s.total -ge 1) "got $($s.total)"
$s = Search 'q=Cooper'
Assert 'q=Cooper (archived excluded by default)' ($s.total -eq 0) "got $($s.total)"

# ── Search by email ────────────────────────────────────────────────────────
$s = Search 'q=mdrimonrana%40gmail.com'
Assert 'q=email -> Rimon Rana' ($s.total -eq 1 -and $s.data[0].email -eq 'mdrimonrana@gmail.com') "got $($s.total)"
$s = Search 'q=TECHVISION'
Assert 'q=email domain (case-insensitive, 39 = 40 - rimon gmail)' ($s.total -eq 39) "got $($s.total)"

# ── Search by employee ID ──────────────────────────────────────────────────
$s = Search 'q=EMP-039'
Assert 'q=EMP-039 -> Marcus Reed' ($s.total -eq 1 -and $s.data[0].firstName -eq 'Marcus') "got $($s.total)"
$s = Search 'q=emp-039'
Assert 'q=emp-039 (lowercase employee id)' ($s.total -eq 1) "got $($s.total)"

# ── Search with filters ────────────────────────────────────────────────────
$s = Search 'q=rimon&status=active'
Assert 'q=rimon & status=active -> 1' ($s.total -eq 1) "got $($s.total)"
$s = Search 'q=rimon&status=inactive'
Assert 'q=rimon & status=inactive -> 0' ($s.total -eq 0) "got $($s.total)"
Assert 'status=active -> 37' ((Search 'status=active').total -eq 37)
Assert 'status=inactive -> 3' ((Search 'status=inactive').total -eq 3)
Assert 'status=all -> 40' ((Search 'status=all').total -eq 40)
Assert 'no status param -> 40 (archived excluded)' ((Search '').total -eq 40)

# ── Empty / nonexistent ────────────────────────────────────────────────────
$s = Search 'q=zzzznobodyzzzz'
Assert 'nonexistent -> empty array + total 0' ($s.data.Count -eq 0 -and $s.total -eq 0)

# ── Pagination (limit/offset) ──────────────────────────────────────────────
$p1 = Search 'limit=5&offset=0'
$p2 = Search 'limit=5&offset=5'
$ids1 = (($p1.data | ForEach-Object { $_.id }) -join ',')
$ids2 = (($p2.data | ForEach-Object { $_.id }) -join ',')
Assert 'offset pagination returns different pages' ($ids1 -ne $ids2 -and $p2.data.Count -eq 5)
$p3 = Search 'limit=5&offset=100'
Assert 'offset beyond total -> empty' ($p3.data.Count -eq 0)

# ── ids hydration ──────────────────────────────────────────────────────────
$rimonId = (Search 'q=rimon').data[0].id
$marcusId = (Search 'q=EMP-039').data[0].id
$h = Search "ids=$rimonId,$marcusId"
Assert 'ids= hydrates both employees' ($h.total -eq 2 -and $h.data.Count -eq 2) "got $($h.data.Count)"

# ── Validation ─────────────────────────────────────────────────────────────
function Expect-400([string]$name, [string]$qs) {
  try { Search $qs | Out-Null; Assert $name $false 'no error thrown' }
  catch { Assert $name ($_.Exception.Response.StatusCode.value__ -eq 400) "got $($_.Exception.Response.StatusCode.value__)" }
}
Expect-400 'limit=0 rejected' 'limit=0'
Expect-400 'limit=51 rejected (max 50)' 'limit=51'
Expect-400 'limit=abc rejected' 'limit=abc'
Expect-400 'offset=-1 rejected' 'offset=-1'
Expect-400 'offset=abc rejected' 'offset=abc'
Expect-400 'status=bogus rejected' 'status=bogus'

# ── Auth ───────────────────────────────────────────────────────────────────
try {
  Invoke-RestMethod -Uri "$base/api/employees/search?q=rimon" -UseBasicParsing | Out-Null
  Assert 'no session -> 401' $false 'no error thrown'
} catch {
  Assert 'no session -> 401' ($_.Exception.Response.StatusCode.value__ -eq 401) "got $($_.Exception.Response.StatusCode.value__)"
}

Write-Host ""
Write-Host "RESULT: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
