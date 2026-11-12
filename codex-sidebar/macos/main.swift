import AppKit
import Foundation

let bundleID = "top.zhengru.codex-quota"
let appName = "Codex 额度助手"
let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/CodexQuotaSidebar", isDirectory: true)
let engine = Bundle.main.resourceURL!.appendingPathComponent("engine", isDirectory: true)

struct CommandResult {
    let code: Int32
    let output: String
}

func execute(_ executable: String, _ arguments: [String], timeout: TimeInterval = 45) -> CommandResult {
    let task = Process()
    let pipe = Pipe()
    task.executableURL = URL(fileURLWithPath: executable)
    task.arguments = arguments
    var environment = ProcessInfo.processInfo.environment
    environment["CODEX_QUOTA_STATE_DIR"] = support.path
    environment["NODE_USE_ENV_PROXY"] = "1"
    environment["NO_PROXY"] = "localhost,127.0.0.1,::1," + (environment["NO_PROXY"] ?? environment["no_proxy"] ?? "")
    environment["no_proxy"] = "localhost,127.0.0.1,::1," + (environment["no_proxy"] ?? "")
    task.environment = environment
    task.standardOutput = pipe
    task.standardError = pipe
    let completed = DispatchSemaphore(value: 0)
    task.terminationHandler = { _ in completed.signal() }
    do { try task.run() }
    catch { return CommandResult(code: 1, output: error.localizedDescription) }
    if completed.wait(timeout: .now() + timeout) == .timedOut {
        task.terminate()
        return CommandResult(code: 1, output: "操作超时，请稍后重试或查看日志。")
    }
    let text = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return CommandResult(code: task.terminationStatus, output: text.trimmingCharacters(in: .whitespacesAndNewlines))
}

func nodeRuntime() -> String? {
    let candidates = [
        "/opt/homebrew/bin/node", "/usr/local/bin/node",
        "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
        "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
    ]
    for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
        let result = execute(candidate, ["-e", "process.exit(typeof WebSocket === 'function' && Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"], timeout: 5)
        if result.code == 0 { return candidate }
    }
    return nil
}

func cli(_ node: String, _ arguments: [String]) -> CommandResult {
    execute(node, [engine.appendingPathComponent("cli.mjs").path] + arguments)
}

final class QuotaApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var item: NSStatusItem!
    private var statusLabel: NSMenuItem!
    private var startItem: NSMenuItem!
    private var stopItem: NSMenuItem!
    private var dlpItem: NSMenuItem!
    private var updateItem: NSMenuItem!
    private var automaticUpdateItem: NSMenuItem!
    private var updateLabel: NSMenuItem!
    private var quitItem: NSMenuItem!
    private var uninstallItem: NSMenuItem!
    private var updateInProgress = false
    private var lastUpdateCheck = Date.distantPast
    private var timer: Timer?
    private var busy = false
    private var quitting = false
    private var node: String?
    private var lastStatus: [String: Any] = [:]
    private let queue = DispatchQueue(label: "top.zhengru.codex-quota.worker")
    private var wanted: Bool {
        get { UserDefaults.standard.bool(forKey: "quotaEnabled") }
        set { UserDefaults.standard.set(newValue, forKey: "quotaEnabled") }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        UserDefaults.standard.register(defaults: ["automaticUpdates": true])
        if CommandLine.arguments.contains("--attach-existing") { wanted = true }
        if CommandLine.arguments.contains("--quota-disabled") { wanted = false }
        NSApp.setActivationPolicy(.accessory)
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "gauge.with.dots.needle.50percent", accessibilityDescription: appName)
        item.button?.title = ""
        item.button?.image?.size = NSSize(width: 18, height: 18)
        item.button?.setAccessibilityLabel(appName)
        item.button?.toolTip = appName
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        statusLabel = NSMenuItem(title: "正在检查状态…", action: nil, keyEquivalent: "")
        statusLabel.isEnabled = false
        menu.addItem(statusLabel)
        menu.addItem(.separator())
        startItem = add(menu, "启动客户端与额度", #selector(startQuota))
        dlpItem = add(menu, "连接 DLP 客户端额度", #selector(connectDlp))
        stopItem = add(menu, "停止额度显示", #selector(stopQuota))
        menu.addItem(.separator())
        _ = add(menu, "查看状态…", #selector(showStatus))
        _ = add(menu, "打开日志", #selector(openLog))
        _ = add(menu, "使用说明…", #selector(showHelp))
        menu.addItem(.separator())
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        updateLabel = NSMenuItem(title: "版本 \(version)", action: nil, keyEquivalent: "")
        updateLabel.isEnabled = false
        menu.addItem(updateLabel)
        updateItem = add(menu, "立即检查并更新", #selector(checkUpdate))
        automaticUpdateItem = add(menu, "自动检查并安装更新", #selector(toggleAutomaticUpdates))
        automaticUpdateItem.state = UserDefaults.standard.bool(forKey: "automaticUpdates") ? .on : .off
        _ = add(menu, "打开更新日志", #selector(openUpdateLog))
        menu.addItem(.separator())
        uninstallItem = add(menu, "卸载额度助手…", #selector(uninstall))
        quitItem = add(menu, "退出额度助手", #selector(quit), "q")
        item.menu = menu
        node = nodeRuntime()
        timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            self?.refreshUpdateStatus()
            self?.checkForUpdates(manual: false)
            self?.refreshStatus(recover: true)
        }
        refreshStatus(recover: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.checkForUpdates(manual: false) }
    }

    private func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let value = NSMenuItem(title: title, action: action, keyEquivalent: key)
        value.target = self
        menu.addItem(value)
        return value
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        item.button?.performClick(nil)
        return false
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting { return .terminateNow }
        quit()
        return .terminateCancel
    }
    func menuWillOpen(_ menu: NSMenu) { refreshUpdateStatus(); refreshStatus(recover: false) }

    private func alert(_ title: String, _ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
    }
    private func setBusy(_ value: Bool) {
        busy = value
        startItem.isEnabled = !value && !updateInProgress
        stopItem.isEnabled = !value && !updateInProgress
        dlpItem.isEnabled = !value && !updateInProgress
        quitItem.isEnabled = !value && !updateInProgress
        uninstallItem.isEnabled = !value && !updateInProgress
        updateItem.isEnabled = !value && !updateInProgress
        if value { statusLabel.title = "正在处理…" }
    }

    private func refreshUpdateStatus() {
        let url = support.appendingPathComponent("update-status.json")
        guard let data = try? Data(contentsOf: url),
              let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let message = value["message"] as? String else { return }
        let active = value["status"] as? String == "updating"
        let pid = value["pid"] as? Int32 ?? 0
        updateInProgress = active && pid > 0 && kill(pid, 0) == 0
        updateLabel.title = active && !updateInProgress ? "上次更新中断，可重试" : message
        updateLabel.toolTip = message
        setBusy(busy)
    }

    private func checkForUpdates(manual: Bool) {
        guard !busy && !quitting && !updateInProgress else { return }
        if !manual {
            guard UserDefaults.standard.bool(forKey: "automaticUpdates") else { return }
            guard Date().timeIntervalSince(lastUpdateCheck) >= 3600 else { return }
        }
        guard node != nil else { return }
        lastUpdateCheck = Date()
        var arguments = ["update"]
        if !wanted { arguments.append("--quota-disabled") }
        if CommandLine.arguments.contains("--dlp-context") { arguments.append("--dlp-context") }
        perform(arguments) { result in
            self.updateInProgress = result.code == 0
            self.setBusy(false)
            self.updateLabel.title = result.code == 0 ? "正在检查远端更新…" : "检查更新失败"
            self.updateItem.isEnabled = result.code != 0
            if result.code != 0 && manual { self.alert("检查更新失败", result.output) }
        }
    }
    @objc private func checkUpdate() { checkForUpdates(manual: true) }
    @objc private func toggleAutomaticUpdates() {
        let enabled = !UserDefaults.standard.bool(forKey: "automaticUpdates")
        UserDefaults.standard.set(enabled, forKey: "automaticUpdates")
        automaticUpdateItem.state = enabled ? .on : .off
        if enabled { checkForUpdates(manual: true) }
    }
    @objc private func openUpdateLog() {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex/share/codexNoProject/codex-quota-update/update.log")
        if FileManager.default.fileExists(atPath: url.path) { NSWorkspace.shared.open(url) }
        else { alert("暂无更新日志", "检查更新后会生成日志。") }
    }

    private func perform(_ arguments: [String], done: @escaping (CommandResult) -> Void) {
        guard !busy else { return }
        guard let node = node else {
            alert("未找到运行环境", "需要已安装的 ChatGPT / Codex 内置 Node.js，或本机 Node.js 22 及以上版本。")
            return
        }
        setBusy(true)
        queue.async {
            let result = cli(node, arguments)
            DispatchQueue.main.async {
                self.setBusy(false)
                done(result)
            }
        }
    }

    private func refreshStatus(recover: Bool, show: Bool = false) {
        guard !busy && !quitting else { return }
        perform(["status", "--json"]) { result in
            guard let bytes = result.output.data(using: .utf8),
                  let status = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else {
                self.statusLabel.title = "无法读取后台状态"
                if show { self.alert("后台状态", result.output) }
                return
            }
            self.lastStatus = status
            let running = status["running"] as? Bool ?? false
            let connected = status["connected"] as? Bool ?? false
            let pages = status["pages"] as? Int ?? 0
            self.statusLabel.title = running ? (connected && pages > 0 ? "额度显示已开启" : "等待客户端连接") : "额度显示已停止"
            if show {
                let connection = connected ? "已连接客户端" : "未连接客户端"
                let endpoints = status["endpoints"] as? [[String: Any]] ?? []
                let details = endpoints.map { endpoint -> String in
                    let port = endpoint["port"] as? Int ?? 0
                    let name = port == 9342 ? "DLP 实例" : (port == 9341 ? "普通实例" : "实例 \(port)")
                    let ready = endpoint["connected"] as? Bool ?? false
                    return "\(name)：\(ready ? "已连接" : "等待连接")"
                }.joined(separator: "\n")
                self.alert("额度助手状态", "\(self.statusLabel.title)\n\(connection)\n\(details)\n\nDLP 实例请从原 DLP 安全终端启动 gpt-safe。首次适配后需退出旧实例再重开。")
            } else if recover && self.wanted && !running && !self.updateInProgress {
                // Recover the watcher without launching a client; DLP may open later.
                // Never call the launch path from a timer or application startup.
                self.perform(["start", "--watch"]) { outcome in
                    if outcome.code == 0 { self.refreshStatus(recover: false) }
                }
            }
        }
    }

    @objc private func startQuota() {
        perform(["start"]) { result in
            if result.code == 0 { self.wanted = true }
            else { self.alert("无法启动额度", result.output) }
            self.refreshStatus(recover: false)
        }
    }
    @objc private func connectDlp() {
        guard CommandLine.arguments.contains("--dlp-context") else {
            alert("从 DLP 终端连接", "请在原 DLP 安全终端运行一次 gpt-safe 或 gpt-safe-detached。它会自动从安全上下文启动额度助手并连接当前 GPT，无需退出 GPT。")
            return
        }
        perform(["start", "--watch"]) { result in
            if result.code == 0 { self.wanted = true }
            else { self.alert("无法连接额度", result.output) }
            self.refreshStatus(recover: false)
        }
    }
    @objc private func stopQuota() {
        wanted = false
        perform(["stop"]) { result in
            if result.code != 0 { self.alert("无法停止额度", result.output) }
            self.refreshStatus(recover: false)
        }
    }
    @objc private func showStatus() { refreshStatus(recover: false, show: true) }
    @objc private func openLog() {
        let log = support.appendingPathComponent("sidebar.log")
        if FileManager.default.fileExists(atPath: log.path) { NSWorkspace.shared.open(log) }
        else { alert("暂无日志", "开启额度显示后会生成日志。") }
    }
    @objc private func showHelp() {
        alert(appName, "普通实例点击「启动客户端与额度」。DLP 实例使用原安全终端中的 gpt-safe 启动，再点击「连接 DLP 客户端额度」；助手会自动等待并连接，两个实例均可显示。\n\n首次适配 DLP 后，旧实例需要退出，再从原 DLP 入口重开。仅重复运行启动器无法为旧进程开启连接。\n\n点击卡片的「网关额度」标题或箭头可收起、展开；会记住本机折叠状态，收起后仍持续更新。额度每 120 秒自动刷新，卡片右上角支持手动刷新。重置时间使用北京时间。\n\n停止额度或退出助手不会退出 ChatGPT。完全退出客户端后，再从普通客户端图标打开，可关闭本机调试端口。\n\n本助手不添加登录项，也不会在开机时打开 ChatGPT。")
    }
    @objc private func quit() {
        guard !busy else { return }
        quitting = true
        timer?.invalidate()
        wanted = false
        if node == nil { NSApp.terminate(nil); return }
        perform(["stop"]) { result in
            if result.code == 0 { NSApp.terminate(nil) }
            else {
                self.quitting = false
                self.alert("退出前清理失败", result.output)
            }
        }
    }
    @objc private func uninstall() {
        guard !busy else { return }
        let expected = Bundle.main.bundleURL.standardizedFileURL
        let allowed = [FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/\(appName).app"), URL(fileURLWithPath: "/Applications/\(appName).app")]
        guard Bundle.main.bundleIdentifier == bundleID && allowed.contains(where: { $0.standardizedFileURL == expected }) else {
            alert("请从已安装的应用卸载", "为保护源码和构建目录，卸载仅适用于 Applications 中安装的 \(appName).app。")
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        let question = NSAlert()
        question.messageText = "卸载额度助手？"
        question.informativeText = "将停止额度显示，删除助手应用、后台状态和日志。ChatGPT / Codex 及项目源码会保留。"
        question.addButton(withTitle: "卸载")
        question.addButton(withTitle: "取消")
        guard question.runModal() == .alertFirstButtonReturn else { return }
        quitting = true
        timer?.invalidate()
        perform(["stop"]) { result in
            guard result.code == 0 else {
                self.quitting = false
                self.alert("卸载未完成", result.output)
                return
            }
            do {
                if FileManager.default.fileExists(atPath: support.path) { try FileManager.default.removeItem(at: support) }
                try FileManager.default.removeItem(at: expected)
                UserDefaults.standard.removePersistentDomain(forName: bundleID)
                NSApp.terminate(nil)
            } catch {
                self.quitting = false
                self.alert("卸载未完成", error.localizedDescription)
            }
        }
    }
}

if CommandLine.arguments.contains("--self-test") {
    guard let node = nodeRuntime(), FileManager.default.fileExists(atPath: engine.appendingPathComponent("lib/widget.js").path) else {
        fputs("Bundled engine or Node.js missing\n", stderr)
        exit(1)
    }
    let result = cli(node, ["status", "--json"])
    print(result.output)
    exit(result.code)
}
let app = NSApplication.shared
let delegate = QuotaApp()
app.delegate = delegate
app.run()
