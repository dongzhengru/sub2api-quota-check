param(
    [string]$MakeIcon,
    [switch]$AttachExisting
)

# Windows tray counterpart of macos/main.swift: a notification-area assistant
# for the quota sidebar. No console window, no administrator rights, no npm
# install; PowerShell 5.1 + WinForms only. Node.js 22+ is discovered exactly
# like sidebar.ps1.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$cli = Join-Path $projectRoot 'codex-sidebar\cli.mjs'
$stateDir = if ($env:CODEX_QUOTA_STATE_DIR) { $env:CODEX_QUOTA_STATE_DIR } else { Join-Path $projectRoot 'codex-sidebar\.state' }
$logPath = Join-Path $stateDir 'sidebar.log'
$trayStatePath = Join-Path $stateDir 'tray.json'
$iconPath = Join-Path $stateDir 'quota.ico'
$appName = 'Codex 额度助手'

# ---- Gauge icon: same visual identity as the macOS menu bar symbol ----

function New-QuotaGaugeBitmap {
    param([int]$Size)
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $scale = $Size / 32.0
        $color = [System.Drawing.Color]::FromArgb(255, 59, 130, 246)
        $inset = 3.5 * $scale
        $diameter = $Size - 2 * $inset
        $arcPen = New-Object System.Drawing.Pen($color, [Math]::Max(1.8, 3.0 * $scale))
        $arcPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $arcPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $rect = New-Object System.Drawing.RectangleF($inset, $inset, $diameter, $diameter)
        # Semicircular gauge: 0% at the left end, 100% at the right end.
        $graphics.DrawArc($arcPen, $rect, 180, 180)
        $cx = $Size / 2.0
        $cy = $Size / 2.0 + 1.5 * $scale
        # Needle near 60%, tilted right so the gauge reads clearly at 16 px.
        $needlePen = New-Object System.Drawing.Pen($color, [Math]::Max(1.6, 2.4 * $scale))
        $needlePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $needlePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $angle = 288 * [Math]::PI / 180
        $length = 9.5 * $scale
        $graphics.DrawLine($needlePen, $cx, $cy, ($cx + $length * [Math]::Cos($angle)), ($cy + $length * [Math]::Sin($angle)))
        $brush = New-Object System.Drawing.SolidBrush($color)
        $radius = 2.6 * $scale
        $graphics.FillEllipse($brush, ($cx - $radius), ($cy - $radius), (2 * $radius), (2 * $radius))
        $arcPen.Dispose()
        $needlePen.Dispose()
        $brush.Dispose()
    } finally { $graphics.Dispose() }
    return $bmp
}

function Get-QuotaIconImageBytes {
    param([System.Drawing.Bitmap]$Bmp)
    # Classic BMP-in-ICO payload (BITMAPINFOHEADER + bottom-up BGRA + AND mask).
    # .NET Framework cannot decode PNG-compressed ICO entries reliably.
    $size = $Bmp.Width
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $data = $Bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $stride = $data.Stride
        $pixels = New-Object byte[] ($stride * $size)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
    } finally { $Bmp.UnlockBits($data) }
    $xor = New-Object byte[] ($size * $size * 4)
    for ($y = 0; $y -lt $size; $y++) {
        [Array]::Copy($pixels, ($size - 1 - $y) * $stride, $xor, $y * $size * 4, $size * 4)
    }
    $andStride = [Math]::Floor(($size + 31) / 32) * 4
    $andMask = New-Object byte[] ($andStride * $size)
    $header = New-Object byte[] 40
    [BitConverter]::GetBytes([int32]40).CopyTo($header, 0)
    [BitConverter]::GetBytes([int32]$size).CopyTo($header, 4)
    [BitConverter]::GetBytes([int32]($size * 2)).CopyTo($header, 8)
    [BitConverter]::GetBytes([int16]1).CopyTo($header, 12)
    [BitConverter]::GetBytes([int16]32).CopyTo($header, 14)
    $ms = New-Object System.IO.MemoryStream
    $ms.Write($header, 0, $header.Length)
    $ms.Write($xor, 0, $xor.Length)
    $ms.Write($andMask, 0, $andMask.Length)
    $payload = $ms.ToArray()
    $ms.Dispose()
    return ,$payload
}

function Save-QuotaIcon {
    param([string]$Path)
    # Multi-size ICO covering common tray DPI sizes (100%–150% scaling).
    $sizes = @(16, 20, 24, 32, 48)
    $images = @()
    foreach ($size in $sizes) {
        $bmp = New-QuotaGaugeBitmap $size
        try { $images += ,@($size, (Get-QuotaIconImageBytes $bmp)) } finally { $bmp.Dispose() }
    }
    $fs = [System.IO.File]::Create($Path)
    try {
        $bw = New-Object System.IO.BinaryWriter($fs)
        $bw.Write([uint16]0)
        $bw.Write([uint16]1)
        $bw.Write([uint16]$images.Count)
        $offset = 6 + 16 * $images.Count
        foreach ($image in $images) {
            $size = $image[0]
            $data = $image[1]
            $bw.Write([byte]$size)
            $bw.Write([byte]$size)
            $bw.Write([byte]0)
            $bw.Write([byte]0)
            $bw.Write([uint16]1)
            $bw.Write([uint16]32)
            $bw.Write([uint32]$data.Length)
            $bw.Write([uint32]$offset)
            $offset += $data.Length
        }
        foreach ($image in $images) { $bw.Write([byte[]]$image[1]) }
        $bw.Flush()
    } finally { $fs.Dispose() }
}

if ($MakeIcon) {
    $parent = Split-Path $MakeIcon -Parent
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Save-QuotaIcon $MakeIcon
    exit 0
}

# ---- Single instance: a second launch opens the running assistant's menu ----

$instanceSuffix = if ($env:CODEX_QUOTA_TRAY_INSTANCE) { '-' + $env:CODEX_QUOTA_TRAY_INSTANCE } else { '' }
$mutexName = 'Local\CodexQuotaTray' + $instanceSuffix
$showName = 'Local\CodexQuotaTrayShow' + $instanceSuffix
$quitName = 'Local\CodexQuotaTrayQuit' + $instanceSuffix
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($false, $mutexName, [ref]$createdNew)
$owns = $false
try { $owns = $mutex.WaitOne(0) }
catch {
    # An abandoned mutex (previous crash) is still acquired by WaitOne.
    $type = $_.Exception
    while ($type -and $type.GetType().Name -ne 'AbandonedMutexException') { $type = $type.InnerException }
    if (!$type) { throw }
    $owns = $true
}
if (!$owns) {
    try {
        $existing = [System.Threading.EventWaitHandle]::OpenExisting($showName)
        [void]$existing.Set()
        $existing.Close()
    } catch { }
    $mutex.Close()
    exit 0
}
$showEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, $showName)
$quitEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, $quitName)

# ---- Node discovery (identical candidates to sidebar.ps1) ----

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$candidates = @()
if ($nodeCommand) { $candidates += $nodeCommand.Source }
$candidates += @(
    "$env:ProgramFiles\nodejs\node.exe",
    "$env:LOCALAPPDATA\nodejs\current\node.exe"
)
$candidates += @(Get-ChildItem -Path "$env:LOCALAPPDATA\OpenAI\Codex\runtimes\cua_node\*\node.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
$node = $null
foreach ($candidate in $candidates | Select-Object -Unique) {
    if (!(Test-Path -LiteralPath $candidate)) { continue }
    & $candidate -e 'process.exit(typeof WebSocket === typeof Function && parseInt(process.versions.node) >= 22 ? 0 : 1)' 2>$null
    if ($LASTEXITCODE -eq 0) { $node = $candidate; break }
}
if (!$node) {
    [System.Windows.Forms.MessageBox]::Show('需要 Node.js 22+。请安装 Node.js，或安装带内置运行时的 Codex / ChatGPT 客户端后重试。', $appName, 'OK', 'Error') | Out-Null
    $mutex.ReleaseMutex()
    $mutex.Close()
    exit 1
}

# ---- Persisted intent (macOS UserDefaults "quotaEnabled" equivalent) ----

$script:wanted = $false
try {
    if (Test-Path -LiteralPath $trayStatePath) {
        $saved = Get-Content -LiteralPath $trayStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $script:wanted = [bool]$saved.quotaEnabled
    }
} catch { $script:wanted = $false }
if ($AttachExisting) { $script:wanted = $true }

function Save-TrayState {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $json = @{ quotaEnabled = $script:wanted } | ConvertTo-Json
    # BOM-less UTF-8: Node's JSON.parse rejects a leading BOM.
    [System.IO.File]::WriteAllText($trayStatePath, $json, (New-Object System.Text.UTF8Encoding($false)))
}
if ($AttachExisting) { Save-TrayState }

# ---- Background CLI worker (keeps the UI thread responsive) ----

$workerSource = @'
param($node, $cli, $cliArgs, $stateDir)
$env:CODEX_QUOTA_STATE_DIR = $stateDir
$env:NODE_USE_ENV_PROXY = '1'
$env:NO_PROXY = "localhost,127.0.0.1,::1,$env:NO_PROXY"
$ErrorActionPreference = 'Continue'
$output = @(& $node $cli @cliArgs 2>&1 | ForEach-Object { $_.ToString() })
$code = $LASTEXITCODE
[pscustomobject]@{ Code = $code; Output = ($output -join [Environment]::NewLine) }
'@
$pool = [runspacefactory]::CreateRunspacePool(1, 2)
$pool.Open()
$pending = New-Object System.Collections.ArrayList

$script:busy = $false
$script:running = $false
$script:quitting = $false
$script:quitPending = $false

function Update-MenuAvailability {
    $startItem.Enabled = !$script:busy
    $stopItem.Enabled = !$script:busy -and $script:running
    $quitItem.Enabled = !$script:busy
}

function Set-StatusDisplay {
    param([string]$State, [string]$Text)
    $statusLabel.Text = $Text
    if ($statusLabel.Image) { $statusLabel.Image.Dispose() }
    $statusLabel.Image = New-StatusDotBitmap $glyphSize $stateColors[$State]
    $notifyIcon.Text = $appName + ' · ' + $Text
}

function Set-Busy {
    param([bool]$Value)
    $script:busy = $Value
    Update-MenuAvailability
    if ($Value) { Set-StatusDisplay 'busy' '正在处理…' }
}

function Invoke-QuotaCommand {
    param([string[]]$CliArgs, [scriptblock]$Done)
    if ($script:busy) { return }
    Set-Busy $true
    $ps = [powershell]::Create()
    $ps.RunspacePool = $pool
    [void]$ps.AddScript($workerSource).AddArgument($node).AddArgument($cli).AddArgument($CliArgs).AddArgument($stateDir)
    $handle = $ps.BeginInvoke()
    [void]$pending.Add(@{ PowerShell = $ps; Handle = $handle; Done = $Done })
}

function Show-Alert {
    param([string]$Title, [string]$Message)
    [System.Windows.Forms.MessageBox]::Show($hiddenForm, $Message, $Title, 'OK', 'Information') | Out-Null
}

function Show-TrayMenu {
    $method = $notifyIcon.GetType().GetMethod('ShowContextMenu', ([System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic))
    if ($method) { $method.Invoke($notifyIcon, $null) | Out-Null }
    else { $notifyIcon.ShowBalloonTip(3000, $appName, $statusLabel.Text, [System.Windows.Forms.ToolTipIcon]::Info) }
}

function Refresh-Status {
    param([bool]$Recover, [bool]$Show = $false)
    if ($script:busy -or $script:quitting) { return }
    Invoke-QuotaCommand @('status', '--json') {
        param($result)
        $status = $null
        try { $status = $result.Output | ConvertFrom-Json } catch { }
        if ($result.Code -ne 0 -or !$status) {
            Set-StatusDisplay 'error' '无法读取后台状态'
            if ($Show) { Show-Alert '后台状态' $result.Output }
            return
        }
        $running = [bool]$status.running
        $connected = [bool]$status.connected
        $pages = [int]$status.pages
        $script:running = $running
        Update-MenuAvailability
        $state = if (!$running) { 'off' } elseif ($connected -and $pages -gt 0) { 'ok' } else { 'wait' }
        $text = if ($running) { if ($connected -and $pages -gt 0) { '额度显示已开启' } else { '等待客户端连接' } } else { '额度显示已停止' }
        Set-StatusDisplay $state $text
        if ($Show) {
            $connection = if ($connected) { '已连接客户端' } else { '未连接客户端' }
            $details = @($status.endpoints | ForEach-Object {
                $name = if ($_.port -eq 9342) { 'DLP 实例' } elseif ($_.port -eq 9341) { '普通实例' } else { "实例 $($_.port)" }
                $ready = if ($_.connected) { '已连接' } else { '等待连接' }
                "${name}：${ready}"
            }) -join [Environment]::NewLine
            Show-Alert '额度助手状态' ($statusLabel.Text + [Environment]::NewLine + $connection + [Environment]::NewLine + $details)
        } elseif ($Recover -and $script:wanted -and !$running) {
            # Recover the watcher without launching a client, mirroring macOS.
            # Never call the launch path from a timer or application startup.
            Invoke-QuotaCommand @('start', '--watch') {
                param($outcome)
                if ($outcome.Code -eq 0) { Refresh-Status $false }
            }
        }
    }
}

function Close-Assistant {
    $notifyIcon.Visible = $false
    $context.ExitThread()
}

function Exit-Assistant {
    if ($script:quitting) { return }
    if ($script:busy) { $script:quitPending = $true; return }
    $script:quitting = $true
    $statusTimer.Stop()
    $script:wanted = $false
    Save-TrayState
    Invoke-QuotaCommand @('stop') {
        param($result)
        if ($result.Code -ne 0) {
            $script:quitting = $false
            Show-Alert '退出前清理失败' $result.Output
            $statusTimer.Start()
            return
        }
        Close-Assistant
    }
}

# ---- Tray UI ----

if (!(Test-Path -LiteralPath $iconPath)) {
    try { Save-QuotaIcon $iconPath } catch { }
}
$trayIcon = $null
if (Test-Path -LiteralPath $iconPath) {
    $small = [System.Windows.Forms.SystemInformation]::SmallIconSize
    $trayIcon = New-Object System.Drawing.Icon($iconPath, $small.Width, $small.Height)
} else {
    $bmp = New-QuotaGaugeBitmap 32
    $trayIcon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $bmp.Dispose()
}

# ---- Menu theme: flat Windows 11 style surface following the app theme ----

$script:darkMode = $false
try {
    $theme = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop
    $script:darkMode = ([int]$theme.AppsUseLightTheme -eq 0)
} catch { }
if ($env:CODEX_QUOTA_TRAY_THEME -eq 'dark') { $script:darkMode = $true }
elseif ($env:CODEX_QUOTA_TRAY_THEME -eq 'light') { $script:darkMode = $false }

if ($script:darkMode) {
    $menuBack = [System.Drawing.Color]::FromArgb(255, 44, 44, 44)
    $menuBorder = [System.Drawing.Color]::FromArgb(255, 69, 69, 69)
    $menuHover = [System.Drawing.Color]::FromArgb(255, 56, 56, 56)
    $menuInk = [System.Drawing.Color]::FromArgb(255, 243, 244, 246)
    $menuMuted = [System.Drawing.Color]::FromArgb(255, 138, 138, 138)
    $glyphInk = [System.Drawing.Color]::FromArgb(255, 229, 231, 235)
    $stateColors = @{
        ok    = [System.Drawing.Color]::FromArgb(255, 52, 211, 153)
        wait  = [System.Drawing.Color]::FromArgb(255, 251, 191, 36)
        off   = [System.Drawing.Color]::FromArgb(255, 138, 138, 138)
        busy  = [System.Drawing.Color]::FromArgb(255, 96, 165, 250)
        error = [System.Drawing.Color]::FromArgb(255, 248, 113, 113)
    }
} else {
    $menuBack = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
    $menuBorder = [System.Drawing.Color]::FromArgb(255, 229, 231, 235)
    $menuHover = [System.Drawing.Color]::FromArgb(255, 243, 244, 246)
    $menuInk = [System.Drawing.Color]::FromArgb(255, 31, 41, 55)
    $menuMuted = [System.Drawing.Color]::FromArgb(255, 156, 163, 175)
    $glyphInk = [System.Drawing.Color]::FromArgb(255, 55, 65, 81)
    $stateColors = @{
        ok    = [System.Drawing.Color]::FromArgb(255, 22, 163, 74)
        wait  = [System.Drawing.Color]::FromArgb(255, 217, 119, 6)
        off   = [System.Drawing.Color]::FromArgb(255, 156, 163, 175)
        busy  = [System.Drawing.Color]::FromArgb(255, 59, 130, 246)
        error = [System.Drawing.Color]::FromArgb(255, 220, 38, 38)
    }
}

$rendererSource = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

public class QuotaMenuColors : ProfessionalColorTable
{
    public Color Back = Color.White;
    public Color Border = Color.Gainsboro;
    public Color Hover = Color.WhiteSmoke;
    public Color Separator = Color.Gainsboro;
    public Color Ink = Color.Black;
    public Color Muted = Color.Gray;

    public override Color ToolStripGradientBegin { get { return Back; } }
    public override Color ToolStripGradientMiddle { get { return Back; } }
    public override Color ToolStripGradientEnd { get { return Back; } }
    public override Color ToolStripBorder { get { return Border; } }
    public override Color ImageMarginGradientBegin { get { return Back; } }
    public override Color ImageMarginGradientMiddle { get { return Back; } }
    public override Color ImageMarginGradientEnd { get { return Back; } }
    public override Color MenuBorder { get { return Border; } }
    public override Color MenuItemBorder { get { return Hover; } }
    public override Color MenuItemSelected { get { return Hover; } }
    public override Color MenuItemSelectedGradientBegin { get { return Hover; } }
    public override Color MenuItemSelectedGradientEnd { get { return Hover; } }
    public override Color MenuItemPressedGradientBegin { get { return Hover; } }
    public override Color MenuItemPressedGradientMiddle { get { return Hover; } }
    public override Color MenuItemPressedGradientEnd { get { return Hover; } }
    public override Color SeparatorDark { get { return Separator; } }
    public override Color SeparatorLight { get { return Separator; } }
    public override Color ToolStripDropDownBackground { get { return Back; } }
}

public class QuotaMenuRenderer : ToolStripProfessionalRenderer
{
    private readonly QuotaMenuColors _colors;
    public float Scale = 1f;

    public QuotaMenuRenderer(QuotaMenuColors colors) : base(colors)
    {
        _colors = colors;
        RoundedEdges = true;
    }

    public static GraphicsPath RoundedRect(Rectangle bounds, float radius)
    {
        float d = radius * 2f;
        GraphicsPath path = new GraphicsPath();
        path.AddArc(bounds.X, bounds.Y, d, d, 180f, 90f);
        path.AddArc(bounds.Right - d, bounds.Y, d, d, 270f, 90f);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0f, 90f);
        path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90f, 90f);
        path.CloseFigure();
        return path;
    }

    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
    {
        Graphics g = e.Graphics;
        Rectangle full = new Rectangle(Point.Empty, e.Item.Size);
        if (e.Item.Enabled && (e.Item.Selected || e.Item.Pressed))
        {
            int inset = (int)Math.Round(4 * Scale);
            Rectangle r = new Rectangle(inset, 1, full.Width - inset * 2, full.Height - 2);
            using (GraphicsPath path = RoundedRect(r, 5f * Scale))
            using (SolidBrush brush = new SolidBrush(_colors.Hover))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.FillPath(brush, path);
            }
        }
        else
        {
            using (SolidBrush brush = new SolidBrush(_colors.Back)) g.FillRectangle(brush, full);
        }
    }

    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
    {
        using (SolidBrush brush = new SolidBrush(_colors.Back))
        {
            e.Graphics.FillRectangle(brush, e.AffectedBounds);
        }
    }

    protected override void OnRenderImageMargin(ToolStripRenderEventArgs e)
    {
        using (SolidBrush brush = new SolidBrush(_colors.Back))
        {
            e.Graphics.FillRectangle(brush, e.AffectedBounds);
        }
    }

    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
    {
        int inset = (int)Math.Round(12 * Scale);
        int y = e.Item.Height / 2;
        using (Pen pen = new Pen(_colors.Separator))
        {
            e.Graphics.DrawLine(pen, inset, y, e.Item.Width - inset, y);
        }
    }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        bool header = object.Equals(e.Item.Tag, "header");
        e.TextColor = (e.Item.Enabled || header) ? _colors.Ink : _colors.Muted;
        base.OnRenderItemText(e);
    }

    protected override void OnRenderItemImage(ToolStripItemImageRenderEventArgs e)
    {
        // Disabled items normally get a faded image; the status dot must keep its state color.
        if (object.Equals(e.Item.Tag, "header") && e.Image != null)
        {
            e.Graphics.DrawImage(e.Image, e.ImageRectangle);
            return;
        }
        base.OnRenderItemImage(e);
    }

    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
    {
        Rectangle bounds = new Rectangle(0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
        using (GraphicsPath path = RoundedRect(bounds, 8f * Scale))
        using (Pen pen = new Pen(_colors.Border))
        {
            pen.Alignment = PenAlignment.Inset;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.DrawPath(pen, path);
        }
    }
}
'@
Add-Type -TypeDefinition $rendererSource -ReferencedAssemblies @('System.Windows.Forms.dll', 'System.Drawing.dll')

function New-StatusDotBitmap {
    param([int]$Size, [System.Drawing.Color]$Color)
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $s = $Size / 16.0
        $ring = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, $Color), [Math]::Max(1.0, 1.2 * $s))
        $outer = 11.5 * $s
        $graphics.DrawEllipse($ring, (($Size - $outer) / 2), (($Size - $outer) / 2), $outer, $outer)
        $brush = New-Object System.Drawing.SolidBrush($Color)
        $inner = 7.5 * $s
        $graphics.FillEllipse($brush, (($Size - $inner) / 2), (($Size - $inner) / 2), $inner, $inner)
        $ring.Dispose()
        $brush.Dispose()
    } finally { $graphics.Dispose() }
    return $bmp
}

function New-MenuGlyphBitmap {
    param([string]$Kind, [int]$Size, [System.Drawing.Color]$Color)
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $s = $Size / 16.0
        $pen = New-Object System.Drawing.Pen($Color, [Math]::Max(1.4, 1.6 * $s))
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $brush = New-Object System.Drawing.SolidBrush($Color)
        switch ($Kind) {
            'play' {
                $points = [System.Drawing.PointF[]]@(
                    (New-Object System.Drawing.PointF((5.4 * $s), (3.8 * $s))),
                    (New-Object System.Drawing.PointF((12.4 * $s), (8.0 * $s))),
                    (New-Object System.Drawing.PointF((5.4 * $s), (12.2 * $s)))
                )
                $path = New-Object System.Drawing.Drawing2D.GraphicsPath
                $path.AddPolygon($points)
                $graphics.FillPath($brush, $path)
                $path.Dispose()
            }
            'stop' {
                $graphics.DrawRectangle($pen, [single](4.6 * $s), [single](4.6 * $s), [single](6.8 * $s), [single](6.8 * $s))
            }
            'info' {
                $graphics.DrawEllipse($pen, [single](2.9 * $s), [single](2.9 * $s), [single](10.2 * $s), [single](10.2 * $s))
                $graphics.FillEllipse($brush, [single](7.25 * $s), [single](5.0 * $s), [single](1.5 * $s), [single](1.5 * $s))
                $graphics.DrawLine($pen, [single](8 * $s), [single](7.6 * $s), [single](8 * $s), [single](10.9 * $s))
            }
            'log' {
                $graphics.DrawRectangle($pen, [single](3.8 * $s), [single](2.6 * $s), [single](8.4 * $s), [single](10.8 * $s))
                $graphics.DrawLine($pen, [single](5.8 * $s), [single](5.8 * $s), [single](10.2 * $s), [single](5.8 * $s))
                $graphics.DrawLine($pen, [single](5.8 * $s), [single](8.0 * $s), [single](10.2 * $s), [single](8.0 * $s))
                $graphics.DrawLine($pen, [single](5.8 * $s), [single](10.2 * $s), [single](8.6 * $s), [single](10.2 * $s))
            }
            'help' {
                $graphics.DrawEllipse($pen, [single](2.9 * $s), [single](2.9 * $s), [single](10.2 * $s), [single](10.2 * $s))
                $font = New-Object System.Drawing.Font('Segoe UI', [single](7.2 * $s), [System.Drawing.FontStyle]::Bold)
                $format = New-Object System.Drawing.StringFormat
                $format.Alignment = [System.Drawing.StringAlignment]::Center
                $format.LineAlignment = [System.Drawing.StringAlignment]::Center
                $rect = New-Object System.Drawing.RectangleF(0, [single](0.6 * $s), $Size, $Size)
                $graphics.DrawString('?', $font, $brush, $rect, $format)
                $format.Dispose()
                $font.Dispose()
            }
            'power' {
                $graphics.DrawArc($pen, [single](3.6 * $s), [single](3.9 * $s), [single](8.8 * $s), [single](8.8 * $s), -60, 300)
                $graphics.DrawLine($pen, [single](8 * $s), [single](2.6 * $s), [single](8 * $s), [single](7.4 * $s))
            }
        }
        $pen.Dispose()
        $brush.Dispose()
    } finally { $graphics.Dispose() }
    return $bmp
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$menu.ShowCheckMargin = $false
$menu.Padding = New-Object System.Windows.Forms.Padding(0, 4, 0, 4)
$dpi = 96
try { $dpi = $menu.DeviceDpi } catch { }
$menuScale = $dpi / 96.0
$glyphSize = [int][Math]::Round(16 * $menuScale)
$menu.ImageScalingSize = New-Object System.Drawing.Size($glyphSize, $glyphSize)
$menu.MinimumSize = New-Object System.Drawing.Size([int](230 * $menuScale), 0)

$menuColors = New-Object QuotaMenuColors
$menuColors.Back = $menuBack
$menuColors.Border = $menuBorder
$menuColors.Hover = $menuHover
$menuColors.Separator = $menuBorder
$menuColors.Ink = $menuInk
$menuColors.Muted = $menuMuted
$menuRenderer = New-Object QuotaMenuRenderer($menuColors)
$menuRenderer.Scale = [single]$menuScale
$menu.Renderer = $menuRenderer

$itemPadding = New-Object System.Windows.Forms.Padding(0, [int](5 * $menuScale), 0, [int](5 * $menuScale))
$separatorMargin = New-Object System.Windows.Forms.Padding(0, [int](3 * $menuScale), 0, [int](3 * $menuScale))

$headerItem = New-Object System.Windows.Forms.ToolStripMenuItem($appName)
$headerItem.Tag = 'header'
$headerItem.Enabled = $false
$headerItem.Font = New-Object System.Drawing.Font($menu.Font, [System.Drawing.FontStyle]::Bold)
$headerItem.Padding = $itemPadding
[void]$menu.Items.Add($headerItem)

$statusLabel = New-Object System.Windows.Forms.ToolStripMenuItem('正在检查状态…')
$statusLabel.Tag = 'header'
$statusLabel.Enabled = $false
$statusLabel.Padding = $itemPadding
$statusLabel.Image = New-StatusDotBitmap $glyphSize $stateColors['busy']
[void]$menu.Items.Add($statusLabel)

$separator1 = New-Object System.Windows.Forms.ToolStripSeparator
$separator1.Margin = $separatorMargin
[void]$menu.Items.Add($separator1)

$startItem = New-Object System.Windows.Forms.ToolStripMenuItem('启动客户端与额度')
$startItem.Image = New-MenuGlyphBitmap 'play' $glyphSize $stateColors['ok']
$startItem.Padding = $itemPadding
$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem('停止额度显示')
$stopItem.Image = New-MenuGlyphBitmap 'stop' $glyphSize $glyphInk
$stopItem.Padding = $itemPadding
$stopItem.Enabled = $false
[void]$menu.Items.Add($startItem)
[void]$menu.Items.Add($stopItem)

$separator2 = New-Object System.Windows.Forms.ToolStripSeparator
$separator2.Margin = $separatorMargin
[void]$menu.Items.Add($separator2)

$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem('查看状态…')
$statusItem.Image = New-MenuGlyphBitmap 'info' $glyphSize $glyphInk
$statusItem.Padding = $itemPadding
$logItem = New-Object System.Windows.Forms.ToolStripMenuItem('打开日志')
$logItem.Image = New-MenuGlyphBitmap 'log' $glyphSize $glyphInk
$logItem.Padding = $itemPadding
$helpItem = New-Object System.Windows.Forms.ToolStripMenuItem('使用说明…')
$helpItem.Image = New-MenuGlyphBitmap 'help' $glyphSize $glyphInk
$helpItem.Padding = $itemPadding
[void]$menu.Items.Add($statusItem)
[void]$menu.Items.Add($logItem)
[void]$menu.Items.Add($helpItem)

$separator3 = New-Object System.Windows.Forms.ToolStripSeparator
$separator3.Margin = $separatorMargin
[void]$menu.Items.Add($separator3)

$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem('退出额度助手')
$quitItem.Image = New-MenuGlyphBitmap 'power' $glyphSize $stateColors['error']
$quitItem.Padding = $itemPadding
[void]$menu.Items.Add($quitItem)

$menu.Add_Opening({
    Refresh-Status $false
    try {
        if ($menu.Width -gt 0 -and $menu.Height -gt 0) {
            $bounds = New-Object System.Drawing.Rectangle(0, 0, $menu.Width, $menu.Height)
            $path = [QuotaMenuRenderer]::RoundedRect($bounds, [single](8 * $menuScale))
            $oldRegion = $menu.Region
            $menu.Region = New-Object System.Drawing.Region($path)
            $path.Dispose()
            if ($oldRegion) { $oldRegion.Dispose() }
        }
    } catch { }
})

$startItem.Add_Click({
    Invoke-QuotaCommand @('start') {
        param($result)
        if ($result.Code -eq 0) {
            $script:wanted = $true
            Save-TrayState
        } elseif ($result.Code -eq 2) {
            $answer = [System.Windows.Forms.MessageBox]::Show($hiddenForm,
                "Codex 已经打开，但当前启动方式没有开启额度连接。`n`n现在重启 Codex 并连接额度吗？请先等待正在进行的任务完成。`n`n请先运行「安装额度启动入口.cmd」修复桌面、开始菜单和已固定的任务栏入口，再通过这些入口启动。商店原始入口和系统恢复仍可能绕过助手。",
                'Codex 额度侧栏', 'YesNo', 'Question', 'Button2')
            if ($answer -eq 'Yes') {
                Invoke-QuotaCommand @('start', '--restart-client') {
                    param($retry)
                    if ($retry.Code -eq 0) { $script:wanted = $true; Save-TrayState }
                    else { Show-Alert '无法启动额度' $retry.Output }
                    Refresh-Status $false
                }
                return
            }
        } else {
            Show-Alert '无法启动额度' $result.Output
        }
        Refresh-Status $false
    }
})
$stopItem.Add_Click({
    $script:wanted = $false
    Save-TrayState
    Invoke-QuotaCommand @('stop') {
        param($result)
        if ($result.Code -ne 0) { Show-Alert '无法停止额度' $result.Output }
        Refresh-Status $false
    }
})
$statusItem.Add_Click({ Refresh-Status $false $true })
$logItem.Add_Click({
    if (Test-Path -LiteralPath $logPath) { Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $logPath + '"') }
    else { Show-Alert '暂无日志' '开启额度显示后会生成日志。' }
})
$helpItem.Add_Click({
    Show-Alert $appName "双击「启动额度侧栏.cmd」或已安装的 Codex 快捷方式，会启动客户端并开启额度，同时在任务栏通知区域显示本助手图标。左键或右键图标打开菜单。`n`n「启动客户端与额度」带上本机调试参数启动客户端；若客户端已运行但未开启调试连接，会询问是否重启，请先等待当前任务完成。`n`n「停止额度显示」移除卡片并停止后台，客户端继续运行。「退出额度助手」先停止额度显示再退出图标；完全退出客户端后，再从普通客户端图标打开，可关闭本机调试端口。`n`n额度每 120 秒自动刷新；点击卡片「网关额度」标题或箭头可收起、展开。重置时间使用北京时间。`n`n助手重新打开后会自动恢复额度后台（仅等待连接，不启动客户端）。本助手不添加登录项，也不会在开机时打开客户端。"
})
$quitItem.Add_Click({ Exit-Assistant })

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = $trayIcon
$notifyIcon.Text = $appName
$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.Add_MouseClick({
    param($sender, $event)
    if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Show-TrayMenu }
})
$notifyIcon.Visible = $true

# Invisible owner form: marshals external show/quit requests onto the UI thread.
$hiddenForm = New-Object System.Windows.Forms.Form
$hiddenForm.ShowInTaskbar = $false
$hiddenForm.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$hiddenForm.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$hiddenForm.Opacity = 0
[void]$hiddenForm.Handle
$context = New-Object System.Windows.Forms.ApplicationContext
$context.MainForm = $hiddenForm

$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 200
$pollTimer.Add_Tick({
    try {
        $signal = [System.Threading.WaitHandle]::WaitAny(@($showEvent, $quitEvent), 0)
        if ($signal -eq 0) { Show-TrayMenu }
        elseif ($signal -eq 1) { Exit-Assistant }
        for ($i = $pending.Count - 1; $i -ge 0; $i--) {
            $job = $pending[$i]
            if (!$job.Handle.IsCompleted) { continue }
            $pending.RemoveAt($i)
            $result = $null
            try {
                $results = $job.PowerShell.EndInvoke($job.Handle)
                if ($results.Count) { $result = $results[0] }
            } catch {
                $result = [pscustomobject]@{ Code = 1; Output = $_.Exception.Message }
            } finally { $job.PowerShell.Dispose() }
            Set-Busy $false
            if (!$result) { $result = [pscustomobject]@{ Code = 1; Output = '后台命令没有返回结果' } }
            try { & $job.Done $result }
            catch { Show-Alert '操作失败' $_.Exception.Message }
        }
        if ($script:quitPending -and !$script:busy) {
            $script:quitPending = $false
            Exit-Assistant
        }
    } catch {
        try { Add-Content -LiteralPath (Join-Path $stateDir 'tray-error.log') -Value ((Get-Date).ToString('s') + ' ' + $_.Exception.Message) -Encoding UTF8 } catch { }
    }
})
$statusTimer = New-Object System.Windows.Forms.Timer
$statusTimer.Interval = 20000
$statusTimer.Add_Tick({ Refresh-Status $true })
$pollTimer.Start()
$statusTimer.Start()
Refresh-Status $true

[System.Windows.Forms.Application]::Run($context)

$pollTimer.Stop()
$statusTimer.Stop()
$notifyIcon.Dispose()
$trayIcon.Dispose()
$hiddenForm.Dispose()
$pool.Close()
$showEvent.Close()
$quitEvent.Close()
$mutex.ReleaseMutex()
$mutex.Close()
exit 0
