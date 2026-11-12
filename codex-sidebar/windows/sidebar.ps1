param(
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action = 'start',
    [switch]$Watch,
    [switch]$Interactive,
    [switch]$RestartClient
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
try {
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
if ($RestartClient) { $quotaArgs += '--restart-client' }
# Capture native stderr as text under Windows PowerShell 5.1 as well.
$ErrorActionPreference = 'Continue'
$output = @(& $quotaNode @quotaArgs 2>&1 | ForEach-Object { $_.ToString() })
$result = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($result -eq 2 -and $Interactive -and $Action -eq 'start' -and !$Watch -and !$RestartClient) {
    Add-Type -AssemblyName System.Windows.Forms
    $answer = [System.Windows.Forms.MessageBox]::Show(
        "Codex 已经打开，但当前启动方式没有开启额度连接。`n`n现在重启 Codex 并连接额度吗？请先等待正在进行的任务完成。`n`n请先运行「安装额度启动入口.cmd」修复桌面、开始菜单和已固定的任务栏入口，再通过这些入口启动。商店原始入口和系统恢复仍可能绕过助手。",
        'Codex 额度侧栏', 'YesNo', 'Question', 'Button2')
    if ($answer -ne 'Yes') { exit 0 }
    $ErrorActionPreference = 'Continue'
    $output = @(& $quotaNode @quotaArgs --restart-client 2>&1 | ForEach-Object { $_.ToString() })
    $result = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
}
if ($result -ne 0) { throw ($output -join [Environment]::NewLine) }
$output | Write-Output
exit 0
} catch {
    $message = $_.Exception.Message
    if ($Interactive) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($message, 'Codex 额度侧栏启动失败', 'OK', 'Error') | Out-Null
    } else { Write-Host $message }
    exit 1
}
