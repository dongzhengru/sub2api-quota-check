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
        "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
        "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
        "/opt/homebrew/bin/node", "/usr/local/bin/node"
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
        if CommandLine.arguments.contains("--attach-existing") { wanted = true }
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
        stopItem = add(menu, "停止额度显示", #selector(stopQuota))
        menu.addItem(.separator())
        _ = add(menu, "查看状态…", #selector(showStatus))
        _ = add(menu, "打开日志", #selector(openLog))
        _ = add(menu, "使用说明…", #selector(showHelp))
        menu.addItem(.separator())
        _ = add(menu, "卸载额度助手…", #selector(uninstall))
        _ = add(menu, "退出额度助手", #selector(quit), "q")
        item.menu = menu
        node = nodeRuntime()
        timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in self?.refreshStatus(recover: true) }
        refreshStatus(recover: true)
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
    func menuWillOpen(_ menu: NSMenu) { refreshStatus(recover: false) }

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
        startItem.isEnabled = !value
        stopItem.isEnabled = !value
        if value { statusLabel.title = "正在处理…" }
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
                self.alert("额度助手状态", "\(self.statusLabel.title)\n\(connection)\n\n不开机自动启动 ChatGPT / Codex。\n使用菜单「启动客户端与额度」来开启。")
            } else if recover && self.wanted && !running && connected {
                // Recover only by attaching to an already-open CDP client.
                // Never call the launch path from a timer or application startup.
                self.perform(["start", "--attach-only"]) { outcome in
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
        alert(appName, "点击「启动客户端与额度」即可使用，无需打开终端。\n\n若客户端已正常打开但没有调试连接，请先用 ⌘Q 退出客户端，再从本菜单启动。\n\n额度每 120 秒自动刷新，卡片右上角支持手动刷新。重置时间使用北京时间。\n\n停止额度或退出助手不会退出 ChatGPT。完全退出客户端后，再从普通客户端图标打开，可关闭本机调试端口。\n\n本助手不添加登录项，也不会在开机时打开 ChatGPT。")
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
        let expected = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/\(appName).app")
        guard Bundle.main.bundleURL.standardizedFileURL == expected.standardizedFileURL else {
            alert("请从已安装的应用卸载", "为保护源码和构建目录，卸载仅适用于 ~/Applications/\(appName).app。")
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
