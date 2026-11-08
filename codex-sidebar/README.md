# Codex 额度侧栏（Windows / macOS / 本机 CDP）

在 Codex / 新版 ChatGPT 客户端的左侧栏底部显示 5 小时、7 天剩余额度、进度条、准确重置日期时间和倒计时。自动查询间隔为 120 秒，右上角刷新图标可立即发起查询。标题右侧的“查看用量”文字按钮可打开用户排行弹窗，默认隐藏，点击时才查询。弹窗支持 1／3／7 天、自定义日期和每页 20／50／100 条分页，按总 Token 排序，Token 显示 K／M，费用以 $ 显示并保留三位小数，悬停可看完整数值。关闭按钮、Esc 或点击遮罩可收起。

用量通过后台请求 `https://gateway.zhengru.top/api/quota/api/user-breakdown`，需要先部署本项目新增的后端接口；旧版服务器返回 404 时会显示错误提示。

固定额度接口：

`https://gateway.zhengru.top/api/quota/api/usage`

无需聊天触发、无需 Skill、无需 npm install，也不需要运行本仓库的 Python 后端。不修改客户端安装包、账户、API 配置或 `.env`。接口展示的是网关后台配置的查询账号额度。

## 启动

### Windows

需要 Node.js 22+，无需 npm install、Python 或管理员权限。支持 Microsoft Store 版 Codex / ChatGPT，以及常见的用户目录、Program Files 安装路径。

1. 首次使用先从客户端菜单或托盘完全退出 Codex / ChatGPT；关闭窗口可能只是隐藏窗口。
2. 双击项目根目录的 **启动额度侧栏.cmd**。启动器会以 `127.0.0.1:9341` 调试参数启动客户端，并开启隐藏的额度后台。
3. 使用 **查看额度状态.cmd** 检查连接，**停止额度侧栏.cmd** 移除卡片并停止后台。客户端保持运行。

也可在 PowerShell 中运行：

```powershell
node .\codex-sidebar\cli.mjs start
node .\codex-sidebar\cli.mjs status --json
node .\codex-sidebar\cli.mjs stop
# 非默认安装路径可指定已安装客户端的可执行文件
node .\codex-sidebar\cli.mjs start --app 'C:\Program Files\Codex\Codex.exe'
# 提前开启后台，等待带调试端口的客户端启动
node .\codex-sidebar\cli.mjs start --watch
```

启动入口仅为当前脚本使用 `ExecutionPolicy Bypass`，不修改系统策略。后台通过 Windows CIM 核验真实可执行文件和监听地址；停止使用本地退出请求，让后台先清理卡片再退出。状态与日志位于 `codex-sidebar/.state/`，不会提交到 Git。未添加开机启动项。

客户端退出后，后台会等待下次连接。下次请继续使用 **启动额度侧栏.cmd** 或指向它的快捷方式打开客户端；普通应用图标启动时不带调试端口。停止侧栏不会关闭客户端的调试端口；完全退出后用普通图标打开即可关闭端口。Windows 版本提供脚本入口，macOS 原生菜单栏助手仅适用于 macOS。

### 推荐：原生菜单栏助手

已安装到 `~/Applications/Codex 额度助手.app`。打开后，屏幕顶部菜单栏出现一个仪表图标，不显示文字：

- **启动客户端与额度**：带上本机调试参数启动客户端并开启额度；若已连接，则复用。
- **连接 DLP 客户端额度**：开启等待连接；DLP GPT 仍由原安全终端入口启动。
- **停止额度显示**：移除卡片，客户端继续运行。
- **查看状态 / 打开日志**：检查助手当前连接情况。
- **卸载额度助手**：停止额度后台，删除助手应用、状态和日志；保留客户端和项目源码。
- **退出额度助手**：停止额度显示并退出菜单栏助手。

不会添加登录项，不会开机自动打开 ChatGPT。助手运行时，额度后台异常退出后可自动恢复；恢复时只等待和连接客户端，不启动客户端；普通实例与 DLP 实例可先后打开。完全退出 ChatGPT 后，从助手菜单再次启动即可；从普通客户端图标打开不带调试参数时，需要先退出后从助手菜单启动。

可以用 Spotlight 搜索「Codex 额度助手」，也可以把应用拖到 Dock。再次打开已运行的助手会展开菜单。

安装后的引擎保存在 `.app` 包内，状态和日志保存在 `~/Library/Application Support/CodexQuotaSidebar/`，不依赖源码目录的位置。原生源码及安装脚本在 `macos/`：

```sh
codex-sidebar/macos/build.sh
codex-sidebar/macos/install.sh
```

构建产物默认位于 `~/.codex/share/codexNoProject/codex-quota-build/`，可用 `CODEX_QUOTA_BUILD_DIR` 指定。安装默认到 `~/Applications`；更新其他安装位置可通过 `CODEX_QUOTA_INSTALL_DIR` 指定。

从 DLP 终端更新安装时，可设置 `CODEX_QUOTA_DLP=1`，使安装器直接在当前上下文启动助手；默认安装行为仍通过系统打开应用。

DLP 启动使用已有代理环境变量，后台通过 `NODE_USE_ENV_PROXY=1` 启用 Node 的环境代理，同时为本机 CDP 配置回环地址直连。

构建需要 macOS 和 Xcode Command Line Tools / Xcode；使用本机临时签名，没有 Apple 开发者公证证书。安装脚本会迁移正在运行的源码版额度后台，不退出 ChatGPT。安装器在应用包尚未生成时自动构建；修改源码后请先重新构建再安装。

### DLP 安全上下文的 GPT

助手同时连接普通实例（本机 9341）和 DLP 实例（本机 9342）；一个实例退出或暂时不可连接时，另一个继续显示。两个实例共用额度查询和缓存，显示的仍是固定网关账号额度。

本机已有 `gpt-safe` / `gpt-safe-detached` 时，运行以下适配脚本一次：

```sh
node codex-sidebar/macos/enable-dlp.mjs
```

脚本为已识别的启动行增加 `--remote-debugging-address=127.0.0.1` 和 `--remote-debugging-port=9342`，并在 GPT 提交启动后从同一安全上下文直接启动已安装的额度助手。保留原安全上下文检查、数据目录、共享账号目录、代理及会话分离逻辑。原文件备份保存在 `~/.codex/share/codexNoProject/codex-quota-dlp/`；不识别的启动器会明确拒绝修改。

首次适配后，需要退出旧 DLP GPT，再从**原 DLP 安全终端或双开入口**重开。已运行的实例无法通过重复执行启动器获得新参数。之后从原 DLP 入口启动即可自动连接。若助手此前从普通桌面启动，启动钩子会核对应用身份、停止该助手及其额度后台，再直接从 DLP 上下文启动助手；GPT 保持运行。已由 DLP 启动的助手会直接复用。助手不会替代 DLP 启动器，也不修改其权限检查。若当前 GPT 已运行而助手未连接，在原 DLP 安全终端运行一次 `gpt-safe` 或 `gpt-safe-detached` 即可。仅从普通桌面打开助手不能保证获得 DLP 的本机连接权限。

源码方式可运行 `node codex-sidebar/cli.mjs start --watch`，只等待连接；`--attach-only` 则要求至少一个客户端已可连接。默认覆盖两个端口，`--port 9342` 可只连接 DLP 实例。

### 源码入口

1. 首次使用时，用 **⌘Q 完全退出 Codex / ChatGPT**。关闭窗口可能没有退出应用。
2. 双击仓库根目录的 **启动额度侧栏.command**。
3. 启动器以 `127.0.0.1:9341` CDP 参数打开客户端，然后在后台挂载卡片。

优先使用本机标准 Node.js 22+，其次使用客户端内置 Node.js。当前机器的 ChatGPT 内置运行时满足要求。支持 `/Applications/Codex.app`、`/Applications/ChatGPT.app`；两个都安装时默认优先 Codex。

启动器不会强制退出正在运行的应用。若应用已经运行但没有开启 CDP，会提示退出后重新启动。若已通过 Dream Skin 启用默认的 9341 端口，可直接连接；本工具使用独立 DOM、Shadow DOM 和全局变量，不主动修改其样式。

卡片跟随应用明暗色，直接显示准确重置时间（北京时间）和倒计时，鼠标停留在额度行可查看已用比例。正常状态不显示更新时间和刷新频率。侧栏折叠时隐藏，侧栏重绘、页面刷新、新窗口和客户端重启后自动尝试重新挂载。客户端重新启动时仍需使用带 CDP 的启动入口。

## 停止与移除

双击根目录的 **停止额度侧栏.command**：停止本工具后台、移除卡片、清理观察器和定时器。未安装系统自启动任务；删除本目录和两个启动文件即可删除本工具。

**停止卡片不关闭客户端的 CDP 调试端口。** DLP 启动器适配也不会在停止或卸载助手时自动撤销；若需关闭 DLP 调试端口，请在两个启动器中移除新增的调试参数，或使用本次备份恢复，再退出并重开该实例。 要关闭 CDP，请 ⌘Q 退出客户端，再从常规应用图标打开。CDP 没有认证，仅监听本机；同机其他进程仍可能连接此端口。

## 命令行与排查

从仓库根目录运行（Node.js 22+）：

```sh
node codex-sidebar/cli.mjs start
node codex-sidebar/cli.mjs status
node codex-sidebar/cli.mjs stop
```

指定端口或应用：

```sh
node codex-sidebar/cli.mjs start --port 9341 --app /Applications/ChatGPT.app
```

源码入口的日志和进程记录存放在 `codex-sidebar/.state/`，已被 Git 忽略；菜单栏助手使用上述 Application Support 目录。日志不包含额度响应、账户凭据或聊天内容。`start` 重复执行会复用对应安装位置的现有后台；改变端口范围前请先 `stop` 再 `start`。`stop` 会核对 PID 对应的脚本及实例标识，不会仅凭 PID 终止其他进程。安装后请使用助手菜单操作，避免同时启用源码版后台。

接口失败时保留上次结果并明确显示“更新失败 · 当前为上次数据”；后台心跳失联超过 45 秒也会显示连接错误，包括首次查询没有成功的情况。数据通过本机进程读取后由 CDP 传入，避免网页 CORS/CSP 对跨域请求的限制。请求不携带 Codex 凭据或本地账号信息。手动刷新会跳过本机 120 秒节流，与其他正在进行的查询合并；服务端自身的缓存仍然生效。

CDP 进程识别使用操作系统映射的可执行文件路径，兼容客户端运行后改变进程标题，以及 Codex 的 Renderer / Service 辅助进程。客户端电脑操作服务可能继承 CDP 监听套接字；只有能够沿父进程链追溯到已验证客户端的额外监听者才会被接受。

若客户端更新后不显示卡片，先检查 `status` 和日志。当前选择器从本机客户端安装包核对过，客户端更新仍可能改变 DOM；可在确认新侧栏结构后用 `--selector 'CSS选择器'` 指定挂载容器。脚本不会在找不到侧栏时改为覆盖主聊天页面。

## 验证范围

- 18 项 Node 自动化测试：数据校验、请求合并、120 秒节流、手动刷新、失败标记、macOS / Windows 可执行文件识别、监听套接字继承、目标过滤、CDP 超时与断线处理，以及 Windows 中文路径状态目录下的真实后台启停。Windows 启停实测在其他系统上跳过。
- 独立 Chromium 实测：真实 CDP 连接、注入、重复调用、紧凑布局、准确日期时间、刷新按钮、侧栏重绘、折叠、错误状态、明暗色截图及完整移除。
- 固定生产接口已经通过实际 Node 查询验证。
- 已在实际客户端挂载新版卡片；首次查询、手动刷新和刷新后的持续连接均已验证。刷新图标采用单次 450 毫秒旋转，颜色跟随明暗色主题。

```sh
node --test codex-sidebar/test/*.test.mjs
node codex-sidebar/test/browser.mjs
```

浏览器测试自动发现 Windows Chrome / Edge 或 macOS Chrome，使用独立临时用户目录，不读取已有浏览器资料；可用 `QUOTA_TEST_CHROME` 指定可执行文件。截图位于 `.state/browser-tests/`，是独立测试页面的渲染图，不是客户端实机截图。

### 卡片闪烁或按钮时有时无

若多个版本的额度后台同时运行，会交替替换卡片。进程检查现已固定使用 UTF-8，并读取完整命令行，避免 Finder／菜单栏的 C 区域设置将中文应用路径转义后误判后台已停止、反复自动恢复。更新时安装器也使用相同的区域设置识别旧助手进程。
