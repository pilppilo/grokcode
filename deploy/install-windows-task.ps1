# Registers a per-user scheduled task that starts grokcode-agent at logon and restarts it on failure.
# Tokens are read from the user environment or from %USERPROFILE%\.config\grokcode\agent.env
# (KEY=value lines). The script does not embed secrets.
#
#   powershell -ExecutionPolicy Bypass -File deploy\install-windows-task.ps1 -AgentPath "$env:APPDATA\npm\grokcode-agent.cmd"

param(
  [string]$TaskName = "GrokcodeAgent",
  [string]$AgentPath = ""
)

$ErrorActionPreference = "Stop"

if (-not $AgentPath) {
  $cmd = Get-Command grokcode-agent -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "grokcode-agent is not on PATH. Pass -AgentPath, or npm install -g the built packages/agent."
  }
  $AgentPath = $cmd.Source
}

$envFile = Join-Path $env:USERPROFILE ".config\grokcode\agent.env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $name, $value = $_.Split("=", 2)
    Set-Item -Path "Env:$($name.Trim())" -Value $value.Trim()
  }
}

$arg = "`"$AgentPath`""
if ($AgentPath -like "*.cmd" -or $AgentPath -like "*.bat") {
  $execute = $env:ComSpec
  $arg = "/c `"`"$AgentPath`"`""
} else {
  $execute = $AgentPath
  $arg = ""
}

$action = New-ScheduledTaskAction -Execute $execute -Argument $arg
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Registered scheduled task $TaskName -> $AgentPath"
Write-Host "Start it now with: Start-ScheduledTask -TaskName $TaskName"
