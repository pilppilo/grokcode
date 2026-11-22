# One-command grokcode install for Windows PowerShell 5.1.
# Checks node, git, and opencode, clones or updates the repo, builds it,
# writes %USERPROFILE%\.config\grokcode\agent.env for the current user only,
# and registers the logon task. Tokens are never printed.
#
# From a checkout:
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-windows.ps1 -MachineName desktop -RelayUrl "wss://YOUR_WORKER.workers.dev/agent" -MachineToken "PASTE_TOKEN" -DefaultModel "opencode-go/deepseek-v4.1-flash" -SetOpenCodeModel
#
# Relay is the default. Add -Listen and -McpToken for direct/Tailscale mode,
# or pass those instead of -RelayUrl to skip the relay.

param(
  [Parameter(Mandatory = $true)][string]$MachineName,
  [string]$RelayUrl = "",
  [string]$MachineToken = "",
  [string]$Listen = "",
  [string]$McpToken = "",
  [string]$OpenCodePassword = "",
  [string]$DefaultModel = "",
  [string]$OpenCodeMode = "attach",
  [switch]$SetOpenCodeModel,
  [string]$RepoUrl = "https://github.com/pilppilo/grokcode.git",
  [string]$InstallDir = "",
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function Require-Command([string]$name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Missing prerequisite: $name. Install it, then re-run this script."
  }
}

function Invoke-Native([scriptblock]$command) {
  & $command
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE."
  }
}

Require-Command "node"
Require-Command "git"
Require-Command "opencode"
$nodeVersion = & node -v
if ($nodeVersion -notmatch '^v(\d+)\.') {
  throw "Could not read the Node.js version from '$nodeVersion'."
}
if ([int]$Matches[1] -lt 20) {
  throw "Node.js 20 or newer is required (found $nodeVersion)."
}

$hasRelay = -not [string]::IsNullOrWhiteSpace($RelayUrl)
$hasDirect = -not [string]::IsNullOrWhiteSpace($Listen)
if (-not $hasRelay -and -not $hasDirect) {
  throw "Pass -RelayUrl and -MachineToken, or -Listen and -McpToken (direct mode)."
}
if ($hasRelay -and [string]::IsNullOrWhiteSpace($MachineToken)) {
  throw "Relay mode needs -MachineToken."
}
if ($hasRelay -and ($MachineToken.Contains("<") -or $MachineToken.Contains(">") -or $MachineToken.Length -lt 16)) {
  throw "-MachineToken looks like a placeholder. Pass the real per-machine token: at least 16 characters, with no < or >. A placeholder must not be written into agent.env."
}
if ($hasDirect -and [string]::IsNullOrWhiteSpace($McpToken)) {
  throw "Direct mode needs -McpToken."
}
if ($SetOpenCodeModel -and [string]::IsNullOrWhiteSpace($DefaultModel)) {
  throw "-SetOpenCodeModel needs -DefaultModel."
}
if ($OpenCodeMode -ne "auto" -and $OpenCodeMode -ne "attach" -and $OpenCodeMode -ne "spawn") {
  throw "-OpenCodeMode must be auto, attach, or spawn."
}

$defaultRepo = Join-Path $env:USERPROFILE ".grokcode\repo"
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $parent = Split-Path -Parent $scriptDir
  $marker = Join-Path $parent "packages\agent\package.json"
  if ($parent -and (Test-Path $marker)) {
    $InstallDir = $parent
  } else {
    $InstallDir = $defaultRepo
  }
}
$reusingHomeRepo = [string]::Equals(
  [System.IO.Path]::GetFullPath($InstallDir),
  [System.IO.Path]::GetFullPath($defaultRepo),
  [System.StringComparison]::OrdinalIgnoreCase
)

if (Test-Path (Join-Path $InstallDir ".git")) {
  if ($reusingHomeRepo) {
    Write-Host "Updating $InstallDir to latest main"
    Invoke-Native { git -C $InstallDir fetch origin main }
    git -C $InstallDir show-ref --verify --quiet refs/heads/main
    if ($LASTEXITCODE -ne 0) {
      Invoke-Native { git -C $InstallDir checkout -b main --track origin/main }
    } else {
      Invoke-Native { git -C $InstallDir checkout main }
    }
    Invoke-Native { git -C $InstallDir pull --ff-only origin main }
  } else {
    Write-Host "Updating $InstallDir"
    Invoke-Native { git -C $InstallDir pull --ff-only }
  }
} elseif (Test-Path (Join-Path $InstallDir "packages\agent\package.json")) {
  Write-Host "Using existing checkout at $InstallDir"
} else {
  $parentDir = Split-Path -Parent $InstallDir
  if ($parentDir -and -not (Test-Path $parentDir)) {
    New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
  }
  Write-Host "Cloning into $InstallDir"
  Invoke-Native { git clone $RepoUrl $InstallDir }
}

Write-Host "Building grokcode"
Push-Location $InstallDir
try {
  Invoke-Native { npm ci }
  Invoke-Native { npm run build }
} finally {
  Pop-Location
}

$configDir = Join-Path $env:USERPROFILE ".config\grokcode"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$envFile = Join-Path $configDir "agent.env"
$writer = Join-Path $InstallDir "packages\agent\dist\write-config.js"

$managed = @(
  "GROKCODE_MACHINE_NAME",
  "GROKCODE_RELAY_URL",
  "GROKCODE_MACHINE_TOKEN",
  "GROKCODE_LISTEN",
  "GROKCODE_MCP_TOKEN",
  "OPENCODE_PASSWORD",
  "GROKCODE_DEFAULT_MODEL",
  "GROKCODE_OPENCODE_MODE"
)
$saved = @{}
foreach ($name in $managed) {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}
try {
  $env:GROKCODE_MACHINE_NAME = $MachineName
  $env:GROKCODE_OPENCODE_MODE = $OpenCodeMode
  if ($hasRelay) {
    $env:GROKCODE_RELAY_URL = $RelayUrl
    $env:GROKCODE_MACHINE_TOKEN = $MachineToken
  }
  if ($hasDirect) {
    $env:GROKCODE_LISTEN = $Listen
    $env:GROKCODE_MCP_TOKEN = $McpToken
  }
  if (-not [string]::IsNullOrWhiteSpace($OpenCodePassword)) {
    $env:OPENCODE_PASSWORD = $OpenCodePassword
  }
  if (-not [string]::IsNullOrWhiteSpace($DefaultModel)) {
    $env:GROKCODE_DEFAULT_MODEL = $DefaultModel
  }
  & node $writer --out $envFile
  if ($LASTEXITCODE -ne 0) { throw "Could not write the agent config." }
} finally {
  foreach ($name in $managed) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    if ($saved[$name]) { Set-Item "Env:$name" -Value $saved[$name] }
  }
}

if ($SetOpenCodeModel) {
  $modelWriter = Join-Path $InstallDir "packages\agent\dist\opencode-config.js"
  & node $modelWriter --model $DefaultModel --home $env:USERPROFILE
  if ($LASTEXITCODE -ne 0) { throw "Could not update the OpenCode config." }
}

$taskScript = Join-Path $InstallDir "deploy\install-windows-task.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $taskScript -AgentDir (Join-Path $InstallDir "packages\agent")
if ($LASTEXITCODE -ne 0) { throw "Could not register the scheduled task." }

if (-not $NoStart) {
  Start-ScheduledTask -TaskName "GrokcodeAgent"
  Write-Host "Scheduled task GrokcodeAgent started."
}

$policyExample = Join-Path $InstallDir "packages\shell\policy.example.json"
$policyCopy = Join-Path $configDir "policy.example.json"
if (-not (Test-Path $policyExample)) {
  throw "Missing $policyExample. The installer copies this file from the repo it just updated."
}
Copy-Item $policyExample $policyCopy -Force
Write-Host "Shell policy example: $policyCopy"
Write-Host "Next: copy the example and set roots before commands are allowed:"
Write-Host '  Copy-Item "$env:USERPROFILE\.config\grokcode\policy.example.json" "$env:USERPROFILE\.config\grokcode\policy.json"'
Write-Host "On this PC the shell is PowerShell 7 (pwsh). Run the agent as your user, not as Administrator."

Write-Host "Installed grokcode for machine $MachineName."
Write-Host "Config: $envFile"
if ($hasRelay) { Write-Host "Relay: configured" }
if ($hasDirect) { Write-Host "Direct listener: configured" }
if (-not [string]::IsNullOrWhiteSpace($DefaultModel)) { Write-Host "Default model: $DefaultModel" }
Write-Host "Logs: $(Join-Path $configDir 'agent.log')"
Write-Host "One-time OpenCode setup so the desktop app and grokcode share one server."
Write-Host "This installer does not run these commands. opencode service set stops a running service:"
Write-Host "  opencode service set hostname 127.0.0.1"
Write-Host "  opencode service set port 4096"
Write-Host "  opencode service set password <the OPENCODE_PASSWORD in $envFile>"
Write-Host "  opencode service start"
