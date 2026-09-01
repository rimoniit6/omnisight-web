# ============================================================================
# OmniSight Agent — CLEAN MACHINE CERTIFICATION (Phase C, Part 4)
#
# Run this on a FRESH Windows VM / second physical machine that must NOT
# contain: Node.js, Git, the source repository, developer tooling, a previous
# OmniSight Agent install, previous agent userData, or previous credentials.
#
# Usage (PowerShell, as the test user):
#   powershell -ExecutionPolicy Bypass -File clean-machine-certification.ps1
#
# Requires one parameter: -ServerUrl (the admin server the agent must reach).
#   Example: .\clean-machine-certification.ps1 -ServerUrl http://192.168.1.50:3000
#
# Captures structured PASS/FAIL evidence to:
#   $env:TEMP\wl-clean-machine-evidence.txt  (+ a console summary)
# ============================================================================
param(
  [string]$ServerUrl = 'http://localhost:3000',
  [string]$InstallerPath = '.\OmniSight Agent Setup 1.0.0.exe'
)

$evidence = @()
function Check($name, $cond, $extra = '') {
  if ($cond) { Write-Host "  [PASS] $name" -ForegroundColor Green; $script:evidence += "PASS | $name" }
  else       { Write-Host "  [FAIL] $name $extra" -ForegroundColor Red;   $script:evidence += "FAIL | $name $extra" }
}

$EvidenceFile = Join-Path $env:TEMP 'wl-clean-machine-evidence.txt'

# ── 0. Preflight: machine must be free of developer tooling ─────────────────
Write-Host "`n=== 0. Preflight (clean machine) ==="
$hasNode = Get-Command node -ErrorAction SilentlyContinue
$hasGit  = Get-Command git  -ErrorAction SilentlyContinue
$hasSrc  = Test-Path 'E:\Workslens\workai'
$hasOldInstall = Test-Path "$env:LOCALAPPDATA\Programs\OmniSightAgent"
$hasOldUserData = Test-Path "$env:APPDATA\worklensai-agent"
Check 'no Node.js installed'       (-not $hasNode)
Check 'no Git installed'           (-not $hasGit)
Check 'no source repository'       (-not $hasSrc)
Check 'no previous agent install'  (-not $hasOldInstall)
Check 'no previous agent userData' (-not $hasOldUserData)
if ($hasNode -or $hasGit -or $hasSrc -or $hasOldInstall -or $hasOldUserData) {
  Write-Host '  WARNING: the machine is not clean. Results below reflect an installed app on a machine with dev tooling.' -ForegroundColor Yellow
}

# ── 1. Launch the installer ─────────────────────────────────────────────────
Write-Host "`n=== 1. Installer ==="
Check 'installer file exists' (Test-Path $InstallerPath)
if (-not (Test-Path $InstallerPath)) { Write-Host 'Installer not found; aborting.'; exit 1 }
$p = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait -PassThru
Check "installer ran to completion (exit $($p.ExitCode))" ($p.ExitCode -eq 0)

$installDir = "$env:LOCALAPPDATA\Programs\OmniSightAgent"
Start-Sleep -Seconds 6
Check 'application installed' (Test-Path "$installDir\OmniSightAgent.exe")

# ── 2. Start-menu shortcut ──────────────────────────────────────────────────
Write-Host "`n=== 2. Start-menu shortcut ==="
$shortcut = Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" -Filter '*OmniSight*' -ErrorAction SilentlyContinue
Check 'start-menu shortcut created' ($null -ne $shortcut)

# ── 3. Launch + no crash + no freeze + native addon ─────────────────────────
Write-Host "`n=== 3. Launch (no crash / no 'Starting...' freeze) ==="
$logPath = Join-Path $env:TEMP 'wl-clean-machine-agent.log'
if (Test-Path $logPath) { Remove-Item $logPath -Force }
$env:OMNISIGHT_SERVER_URL = $ServerUrl
$proc = Start-Process -FilePath "$installDir\OmniSightAgent.exe" -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.err" -PassThru
Start-Sleep -Seconds 15
$stillAlive = -not $proc.HasExited
Check 'agent process alive after 15s (no crash)' $stillAlive

$log = ''
if (Test-Path $logPath) { $log = Get-Content $logPath -Raw -ErrorAction SilentlyContinue }
if (Test-Path "$logPath.err") { $log += "`n" + (Get-Content "$logPath.err" -Raw -ErrorAction SilentlyContinue) }

Check 'boot log written'      ($log -match '"event":"boot"')
Check 'no renderer exception' ($log -notmatch 'Uncaught|ReferenceError|SyntaxError|Unable to load preload|Cannot find module')
Check 'discover started' ($log -match 'discover-start|discover\.start')

# Native addon load: the packaged addon must be present beside the app.
$native = "$installDir\resources\native\worklens_capture.node"
Check 'native addon packaged' (Test-Path $native)

# ── 4. Stop the agent ───────────────────────────────────────────────────────
Write-Host "`n=== 4. Teardown ==="
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# ── 5. Evidence file ────────────────────────────────────────────────────────
$evidence | Out-File -FilePath $EvidenceFile -Encoding utf8
Write-Host "`nEvidence written to: $EvidenceFile"
$pass = ($evidence | Where-Object { $_ -like 'PASS*' }).Count
$fail = ($evidence | Where-Object { $_ -like 'FAIL*' }).Count
Write-Host "CERTIFICATION RESULT: $pass passed, $fail failed"
exit $(if ($fail -gt 0) { 1 } else { 0 })
