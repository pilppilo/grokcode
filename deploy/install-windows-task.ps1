# Registers a per-user scheduled task that runs start-agent.ps1 at logon.
# The task action is:
#   powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File <cfg>\start-agent.ps1
# It restarts up to 10 times, once a minute, with no execution time limit.
# Re-running this script replaces the task. It does not print secrets.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-windows-task.ps1 -AgentDir C:\src\grokcode\packages\agent

param(
  [string]$TaskName = "GrokcodeAgent",
  [string]$ConfigDir = "",
  [string]$AgentDir = "",
  [string]$NodePath = "",
  [string[]]$ExtraPath = @()
)

$ErrorActionPreference = "Stop"

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
  throw "node.exe was not found. Install Node.js 20 or newer and re-run."
}

function Grant-CurrentUserOnly([string]$path) {
  if (-not (Test-Path $path)) { return }
  $item = Get-Item $path
  $acl = $item.GetAccessControl()
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) {
    [void]$acl.RemoveAccessRule($rule)
  }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  if ($item.PSIsContainer) {
    $inherit = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit"
    $prop = [System.Security.AccessControl.PropagationFlags]::None
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, "FullControl", $inherit, $prop, "Allow")
  } else {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, "FullControl", "Allow")
  }
  $acl.AddAccessRule($rule)
  Set-Acl -Path $path -AclObject $acl
}

if (-not $ConfigDir) {
  $ConfigDir = Join-Path $env:USERPROFILE ".config\grokcode"
}
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$ConfigDir = (Resolve-Path $ConfigDir).Path

if (-not $AgentDir) {
  $repo = Split-Path -Parent $PSScriptRoot
  $candidate = Join-Path $repo "packages\agent"
  if (Test-Path (Join-Path $candidate "dist\cli.js")) {
    $AgentDir = $candidate
  }
}
if (-not $AgentDir -or -not (Test-Path (Join-Path $AgentDir "dist\cli.js"))) {
  throw "Pass -AgentDir pointing at packages\agent (the folder that contains dist\cli.js). Build the repo first."
}
$AgentDir = (Resolve-Path $AgentDir).Path

$nodeExe = Resolve-NodeExe $NodePath
$oc = Get-Command opencode -ErrorAction SilentlyContinue
if ($oc -and $oc.Source) {
  $ocDir = Split-Path -Parent $oc.Source
  if ($ExtraPath -notcontains $ocDir) {
    $ExtraPath += $ocDir
  }
}

$launcher = @{
  node = $nodeExe
  agentDir = $AgentDir
  extraPath = @($ExtraPath)
}
$launcherPath = Join-Path $ConfigDir "launcher.json"
$launcher | ConvertTo-Json -Compress | Set-Content -Path $launcherPath -Encoding ASCII

$source = Join-Path $PSScriptRoot "start-agent.ps1"
if (-not (Test-Path $source)) {
  throw "Missing $source"
}
$script = Join-Path $ConfigDir "start-agent.ps1"
Copy-Item -Force $source $script
Grant-CurrentUserOnly $ConfigDir
if (Test-Path (Join-Path $ConfigDir "agent.env")) {
  Grant-CurrentUserOnly (Join-Path $ConfigDir "agent.env")
}

$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$argument = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$action = New-ScheduledTaskAction -Execute $powershell -Argument $argument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
try { $settings.MultipleInstances = "IgnoreNew" } catch { }
$settings.StartWhenAvailable = $true
$settings.ExecutionTimeLimit = "PT0S"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "Registered scheduled task $TaskName"
Write-Host "Launcher: $script"
Write-Host "Node: $nodeExe"
Write-Host "Agent: $AgentDir"
Write-Host "Start it with: Start-ScheduledTask -TaskName $TaskName"
