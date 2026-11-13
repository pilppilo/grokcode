# grokcode agent launcher for Windows Task Scheduler (Windows PowerShell 5.1).
# Installed to %USERPROFILE%\.config\grokcode\start-agent.ps1.
# Reads launcher.json (node, agentDir, extraPath) from the same directory.
# Loads agent.env into the process environment, overriding stale values such
# as GROKCODE_OPENCODE_MODE, then keeps `node dist\cli.js` running with that
# environment copied explicitly (Windows PowerShell 5.1 Start-Process can
# otherwise keep the environment from before those assignments).

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

function Read-AgentEnvText([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  if ($bytes.Length -ge 2 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254) {
    return [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
  }
  if ($bytes.Length -ge 2 -and $bytes[0] -eq 254 -and $bytes[1] -eq 255) {
    return [System.Text.Encoding]::BigEndianUnicode.GetString($bytes, 2, $bytes.Length - 2)
  }
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
    return [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
  }
  $zeros = 0
  $n = [Math]::Min($bytes.Length, 64)
  for ($i = 1; $i -lt $n; $i += 2) {
    if ($bytes[$i] -eq 0) { $zeros++ }
  }
  if ($zeros -ge 4) {
    return [System.Text.Encoding]::Unicode.GetString($bytes)
  }
  return [System.Text.Encoding]::Default.GetString($bytes)
}

function Import-AgentEnv([string]$path) {
  if (-not (Test-Path $path)) { return }
  # The file is the installed config. Override a stale process variable such as
  # GROKCODE_OPENCODE_MODE=auto left by an older installer or user environment.
  $text = Read-AgentEnvText $path
  foreach ($raw in ($text -split "\r?\n")) {
    $line = $raw.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { continue }
    if ($line.StartsWith("export ")) { $line = $line.Substring(7).Trim() }
    $hash = $line.IndexOf(" #")
    if ($hash -gt 0) { $line = $line.Substring(0, $hash).Trim() }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { continue }
    $name = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim()
    if ($value.Length -ge 2) {
      $open = $value.Substring(0, 1)
      $close = $value.Substring($value.Length - 1, 1)
      if (($open -eq '"' -and $close -eq '"') -or ($open -eq "'" -and $close -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    Set-Item -Path "Env:$name" -Value $value
    if ($name -eq "GROKCODE_OPENCODE_MODE") {
      Remove-Item Env:GROKCODE_SPAWN -ErrorAction SilentlyContinue
    }
  }
}

function Start-NodeAgent([string]$nodeExe, [string]$agentDir, [string]$outLog, [string]$errLog) {
  # Start-Process in Windows PowerShell 5.1 can keep the environment from
  # before this script's $env: assignments. Copy the process environment
  # explicitly after Import-AgentEnv so agent.env wins.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $nodeExe
  $psi.Arguments = "dist\cli.js"
  $psi.WorkingDirectory = $agentDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $vars = [Environment]::GetEnvironmentVariables("Process")
  foreach ($key in @($vars.Keys)) {
    $psi.EnvironmentVariables[[string]$key] = [string]$vars[$key]
  }
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $stdout = $proc.StandardOutput.ReadToEndAsync()
  $stderr = $proc.StandardError.ReadToEndAsync()
  $proc.WaitForExit()
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::AppendAllText($outLog, $stdout.Result, $utf8)
  [System.IO.File]::AppendAllText($errLog, $stderr.Result, $utf8)
  return $proc.ExitCode
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
  # Wait until node exits. OpenCode is not a child of this process.
  $code = Start-NodeAgent $nodeExe $agentDir $outLog $errLog
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-LogLine $log "$stamp agent exited $code"
  Start-Sleep -Seconds 10
}
