param(
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action = 'start',
    [switch]$Watch
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$candidates = @()
if ($nodeCommand) { $candidates += $nodeCommand.Source }
$candidates += @(
    "$env:ProgramFiles\nodejs\node.exe",
    "$env:LOCALAPPDATA\nodejs\current\node.exe"
)
$candidates += @(Get-ChildItem -Path "$env:LOCALAPPDATA\OpenAI\Codex\runtimes\cua_node\*\node.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
$quotaNode = $null
foreach ($candidate in $candidates | Select-Object -Unique) {
    if (!(Test-Path -LiteralPath $candidate)) { continue }
    & $candidate -e 'process.exit(typeof WebSocket === typeof Function && parseInt(process.versions.node) >= 22 ? 0 : 1)' 2>$null
    if ($LASTEXITCODE -eq 0) { $quotaNode = $candidate; break }
}
if (!$quotaNode) { throw 'Node.js 22+ is required. Install Node.js and run this launcher again.' }

$env:NODE_USE_ENV_PROXY = '1'
$env:NO_PROXY = "localhost,127.0.0.1,::1,$env:NO_PROXY"
# Windows environment variable names are case-insensitive.
$quotaArgs = @((Join-Path $projectRoot 'codex-sidebar\cli.mjs'), $Action)
if ($Watch) { $quotaArgs += '--watch' }
& $quotaNode @quotaArgs
exit $LASTEXITCODE
