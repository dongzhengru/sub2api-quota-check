param(
    [string]$DesktopDirectory = [Environment]::GetFolderPath('Desktop'),
    [string]$ProgramsDirectory = [Environment]::GetFolderPath('Programs'),
    [string]$TaskbarDirectory = (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
    [string]$BackupDirectory = (Join-Path $PSScriptRoot '..\.state\shortcut-backup')
)
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$launcher = Join-Path $PSScriptRoot 'launch.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shell = New-Object -ComObject WScript.Shell
$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
$icon = if ($package) { Join-Path $package.InstallLocation 'app\ChatGPT.exe' } else { $wscript }
if (!(Test-Path -LiteralPath $icon)) { $icon = $wscript }
$trayLauncher = Join-Path $PSScriptRoot 'tray.vbs'
foreach ($dir in @($DesktopDirectory, $ProgramsDirectory, $BackupDirectory)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
# One launch entry per surface: it starts the client, the quota daemon and
# attaches the tray assistant, so separate Codex/assistant links are redundant.
$entries = @(
    @{Path=(Join-Path $DesktopDirectory 'Codex 额度侧栏.lnk'); Backup='Desktop-Quota.lnk'},
    @{Path=(Join-Path $ProgramsDirectory 'Codex 额度侧栏.lnk'); Backup='Programs-Quota.lnk'}
)
$removals = @(
    @{Path=(Join-Path $DesktopDirectory 'Codex.lnk'); Backup='Desktop-Codex.lnk'},
    @{Path=(Join-Path $ProgramsDirectory 'Codex.lnk'); Backup='Programs-Codex.lnk'},
    @{Path=(Join-Path $DesktopDirectory 'Codex 额度助手.lnk'); Backup='Desktop-Assistant.lnk'},
    @{Path=(Join-Path $ProgramsDirectory 'Codex 额度助手.lnk'); Backup='Programs-Assistant.lnk'}
)
# Pinned taskbar links are independent copies. Updating Desktop/Programs does
# not repair their old Store target or AppUserModel activation properties.
if (Test-Path -LiteralPath $TaskbarDirectory) {
    foreach ($file in Get-ChildItem -LiteralPath $TaskbarDirectory -Filter '*.lnk') {
        $pinned = $shell.CreateShortcut($file.FullName)
        if ($pinned.TargetPath -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:Codex|ChatGPT)\.exe$' -or
            ($file.BaseName -eq 'Codex' -and $pinned.TargetPath -match '\\(?:Codex|ChatGPT)\.exe$') -or
            $pinned.Arguments -eq ('"' + $launcher + '"')) {
            $entries += @{Path=$file.FullName; Backup=('TaskBar-' + $file.Name)}
        }
    }
}
# Older Store builds created a misleading ChatGPT entry with a versioned Codex
# path. Repair it too, but leave a separately installed ChatGPT app untouched.
$legacyPath = Join-Path $ProgramsDirectory 'ChatGPT.lnk'
if (Test-Path -LiteralPath $legacyPath) {
    $legacy = $shell.CreateShortcut($legacyPath)
    if ($legacy.TargetPath -match '\\WindowsApps\\OpenAI\.Codex_' -or $legacy.Arguments -eq ('"' + $launcher + '"')) {
        $removals += @{Path=$legacyPath; Backup='Programs-ChatGPT.lnk'}
    }
}
# Only retire links this project owns; unrelated user shortcuts stay untouched.
$removals = @($removals | Where-Object {
    if (!(Test-Path -LiteralPath $_.Path)) { return $false }
    $link = $shell.CreateShortcut($_.Path)
    $link.Arguments -eq ('"' + $launcher + '"') -or $link.Arguments -eq ('"' + $trayLauncher + '"') -or
        $link.TargetPath -match '\\WindowsApps\\OpenAI\.Codex_' -or $link.TargetPath -match '\\(?:Codex|ChatGPT)\.exe$'
})
if (!('QuotaShortcutNotify' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QuotaShortcutNotify {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern void SHChangeNotify(uint change, uint flags, string path, IntPtr other);
}
'@
}
function Backup-ThenRemove {
    param([string]$Path, [string]$Backup)
    if (!(Test-Path -LiteralPath $Path)) { return }
    if (!(Test-Path -LiteralPath $Backup)) { Copy-Item -LiteralPath $Path -Destination $Backup }
    Remove-Item -LiteralPath $Path
    [QuotaShortcutNotify]::SHChangeNotify(0x2000, 0x1005, $Path, [IntPtr]::Zero)
    Write-Output ('Removed ' + $Path)
}
foreach ($entry in $removals) { Backup-ThenRemove $entry.Path (Join-Path $BackupDirectory $entry.Backup) }
foreach ($entry in $entries) {
    $backup = Join-Path $BackupDirectory $entry.Backup
    if ((Test-Path -LiteralPath $entry.Path) -and !(Test-Path -LiteralPath $backup)) {
        Copy-Item -LiteralPath $entry.Path -Destination $backup
    }
    # Recreate Store links as ordinary shortcuts rather than retaining their
    # AppUserModel activation metadata, which can ignore TargetPath/Arguments.
    if (Test-Path -LiteralPath $entry.Path) { Remove-Item -LiteralPath $entry.Path }
    $link = $shell.CreateShortcut($entry.Path)
    $link.TargetPath = $wscript
    $link.Arguments = '"' + $launcher + '"'
    $link.WorkingDirectory = $root
    $link.IconLocation = "$icon,0"
    $link.Description = '启动 Codex 并自动连接额度侧栏'
    $link.Save()
    # Tell Explorer that the pinned copy changed, without restarting Explorer
    # or interrupting the running Codex application.
    [QuotaShortcutNotify]::SHChangeNotify(0x2000, 0x1005, $entry.Path, [IntPtr]::Zero)
    Write-Output $entry.Path
}
Write-Output "Original shortcuts: $BackupDirectory"
