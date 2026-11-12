# grokcode agent launcher for Windows Task Scheduler (Windows PowerShell 5.1).
# Installed to %USERPROFILE%\.config\grokcode\start-agent.ps1.
# Reads launcher.json (node, agentDir, extraPath) from the same directory.
# Loads agent.env into the process environment without overriding variables
# that are already set, then keeps `node dist\cli.js` running.

$ErrorActionPreference = "Stop"

$cfg = Split-Path -Parent $MyInvocation.MyCommand.Path
$settingsPath = Join-Path $cfg "launcher.json"
if (-not (Test-Path $settingsPath)) {
  throw "Missing $settingsPath. Run deploy\install-windows-task.ps1."
}
$settings = Get-Content -Path $settingsPath -Raw | ConvertFrom-Json
$agentDir = [string]$settings.agentDir
if (-not $agentDir -or -not (Test-Path (Join-Path $agentDir "dist\cli.js"))) {
  throw "dist\cli.js was not found in '$agentDir'."
}

function Resolve-NodeExe([string]$Preferred) {
  if ($Preferred -and (Test-Path $Preferred)) {
    return (Resolve-Path $Preferred).Path
  }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -and ($cmd.Source -like "*.exe")) {
    return $cmd.Source
  }
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "nodejs\node.exe") }
  $pf86 = ${env:ProgramFiles(x86)}
  if ($pf86) { $candidates += (Join-Path $pf86 "nodejs\node.exe") }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe") }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  throw "node.exe was not found. Install Node.js 20 or newer and re-run the installer."
}

function Import-AgentEnv([string]$path) {
  if (-not (Test-Path $path)) { return }
  Get-Content -Path $path | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    if ($line.StartsWith("export ")) { $line = $line.Substring(7).Trim() }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { return }
    $name = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim()
    if ($value.Length -ge 2) {
      $open = $value.Substring(0, 1)
      $close = $value.Substring($value.Length - 1, 1)
      if (($open -eq '"' -and $close -eq '"') -or ($open -eq "'" -and $close -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    $existing = [Environment]::GetEnvironmentVariable($name, "Process")
    if ($existing) { return }
    Set-Item -Path "Env:$name" -Value $value
  }
}

function Rotate-Log([string]$path) {
  if (-not (Test-Path $path)) { return }
  if ((Get-Item $path).Length -le 1048576) { return }
  $backup = "$path.1"
  if (Test-Path $backup) { Remove-Item -Force $backup }
  Move-Item -Force $path $backup
}

function Add-LogLine([string]$path, [string]$line) {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::AppendAllText($path, $line + [Environment]::NewLine, $utf8)
}

$nodeExe = Resolve-NodeExe ([string]$settings.node)
$nodeDir = Split-Path -Parent $nodeExe
$prefix = New-Object System.Collections.Generic.List[string]
$prefix.Add($nodeDir) | Out-Null
$npmDir = Join-Path $env:APPDATA "npm"
if (Test-Path $npmDir) { $prefix.Add($npmDir) | Out-Null }
$opencodeDir = Join-Path $env:USERPROFILE ".opencode\bin"
if (Test-Path $opencodeDir) { $prefix.Add($opencodeDir) | Out-Null }
if ($settings.extraPath) {
  foreach ($entry in @($settings.extraPath)) {
    if ($entry) { $prefix.Add([string]$entry) | Out-Null }
  }
}
$env:PATH = ($prefix -join ";") + ";" + $env:PATH
$env:NODE_NO_WARNINGS = "1"
Import-AgentEnv (Join-Path $cfg "agent.env")

$log = Join-Path $cfg "agent.log"
$outLog = Join-Path $cfg "agent-out.log"
$errLog = Join-Path $cfg "agent-err.log"
Set-Location $agentDir

while ($true) {
  Rotate-Log $log
  Rotate-Log $outLog
  Rotate-Log $errLog
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-LogLine $log "$stamp starting agent"
  $proc = Start-Process -FilePath $nodeExe -ArgumentList "dist\cli.js" -WorkingDirectory $agentDir -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru -Wait
  $code = 1
  if ($proc -and $null -ne $proc.ExitCode) { $code = [int]$proc.ExitCode }
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-LogLine $log "$stamp agent exited $code"
  Start-Sleep -Seconds 10
}
