// P0 performance baseline: launch the desktop app once and print one JSON line.
//
//   swift tests/perf/app-launch.swift <New WindTerm P0.app> startup
//   swift tests/perf/app-launch.swift <New WindTerm P0.app> resources
//
// startup:   LaunchServices launch -> first on-screen window (CGWindowList, 2 ms
//            polling) -> "本地终端" button exposed through the Accessibility API
//            (25 ms polling) -> quit.
// resources: launch -> window -> ps samples of the app and every process whose
//            responsible pid is the app (WebKit helpers, shell) at +10 s and
//            +20 s -> press "本地终端" through AX (bounded retry) -> wait
//            for the zsh child -> samples at +10 s and +20 s after the press
//            -> quit.
// Needs Accessibility permission for the calling terminal. Never types into
// the terminal, never reads its contents, and always quits the launched app.
import AppKit
import ApplicationServices
import Foundation

struct Sample {
  let pid: pid_t
  let rssKiB: Double
  let cpuPercent: Double
  let cpuSeconds: Double
  let name: String
}

typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
let responsible: ResponsibleFn? = dlsym(dlopen(nil, RTLD_NOW), "responsibility_get_pid_responsible_for_pid")
  .map { unsafeBitCast($0, to: ResponsibleFn.self) }

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("app-launch: \(message)\n".utf8))
  exit(1)
}

let started = DispatchTime.now().uptimeNanoseconds
func elapsedMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000 }

func spin(until deadlineMs: Double, every ms: Double = 2, _ done: () -> Bool) -> Bool {
  while elapsedMs() < deadlineMs {
    if done() { return true }
    RunLoop.current.run(until: Date().addingTimeInterval(ms / 1000))
  }
  return done()
}

func sleepUntil(_ ms: Double) { _ = spin(until: ms, every: 50) { false } }

// "M:SS.ss" or "H:MM:SS.ss" cumulative user+system CPU time from ps.
func cpuSeconds(_ text: Substring) -> Double {
  text.split(separator: ":").reduce(0) { $0 * 60 + (Double($1) ?? 0) }
}

func processFamily(of app: pid_t) -> [Sample] {
  let ps = Process()
  ps.executableURL = URL(fileURLWithPath: "/bin/ps")
  ps.arguments = ["-axo", "pid=,rss=,%cpu=,time=,comm="]
  let pipe = Pipe()
  ps.standardOutput = pipe
  do { try ps.run() } catch { fail("ps failed: \(error)") }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  ps.waitUntilExit()
  return String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { line in
    let parts = line.split(separator: " ", maxSplits: 4, omittingEmptySubsequences: true)
    guard parts.count == 5, let pid = pid_t(parts[0]) else { return nil }
    guard pid == app || responsible?(pid) == app else { return nil }
    return Sample(pid: pid, rssKiB: Double(parts[1]) ?? 0, cpuPercent: Double(parts[2]) ?? 0,
                  cpuSeconds: cpuSeconds(parts[3]), name: String(parts[4].split(separator: "/").last ?? ""))
  }
}

func hasWindow(_ pid: pid_t) -> Bool {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return false }
  return windows.contains { window in
    guard (window[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid,
          (window[kCGWindowLayer as String] as? Int) == 0,
          let bounds = window[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: bounds) else { return false }
    return rect.height >= 300
  }
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

var lastAxVisited = 0
var lastAxRoles: [String: Int] = [:]
func findButton(_ pid: pid_t, label: String) -> AXUIElement? {
  let root = AXUIElementCreateApplication(pid)
  // The default 6 s AX messaging timeout is tight on a heavily loaded machine.
  AXUIElementSetMessagingTimeout(root, 10)
  var queue = [root]
  var visited = 0
  var roles: [String: Int] = [:]
  defer { lastAxVisited = visited; lastAxRoles = roles }
  while !queue.isEmpty && visited < 20_000 {
    let element = queue.removeFirst()
    visited += 1
    let role = attribute(element, kAXRoleAttribute) as? String ?? "?"
    roles[role, default: 0] += 1
    if role == kAXButtonRole as String {
      let texts = [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].compactMap { attribute(element, $0) as? String }
      if texts.contains(where: { $0.contains(label) }) { return element }
    }
    queue.append(contentsOf: (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [])
  }
  return nil
}

func summary(_ samples: [Sample], app: pid_t) -> [String: Double] {
  let webkit = samples.filter { $0.name.hasPrefix("com.apple.WebKit") }
  return [
    "rss_main_mib": samples.filter { $0.pid == app }.reduce(0) { $0 + $1.rssKiB } / 1024,
    "rss_webkit_mib": webkit.reduce(0) { $0 + $1.rssKiB } / 1024,
    "rss_total_mib": samples.reduce(0) { $0 + $1.rssKiB } / 1024,
    "ps_cpu_main_pct": samples.filter { $0.pid == app }.reduce(0) { $0 + $1.cpuPercent },
    "ps_cpu_total_pct": samples.reduce(0) { $0 + $1.cpuPercent },
    "processes": Double(samples.count),
  ]
}

// Average CPU% of the process family between two samples (pid-matched).
func windowCpu(_ first: [Sample], _ second: [Sample], seconds: Double) -> Double {
  let before = Dictionary(uniqueKeysWithValues: first.map { ($0.pid, $0.cpuSeconds) })
  let used = second.reduce(0) { $0 + max(0, $1.cpuSeconds - (before[$1.pid] ?? 0)) }
  return 100 * used / seconds
}

func loadAverage() -> Double {
  var loads = [Double](repeating: 0, count: 3)
  return getloadavg(&loads, 3) == 3 ? loads[0] : -1
}

let args = CommandLine.arguments
guard args.count == 3, args[1].hasSuffix(".app"), ["startup", "resources"].contains(args[2]) else {
  fail("usage: app-launch.swift <App.app> startup|resources")
}
guard AXIsProcessTrusted() else { fail("Accessibility permission is required for the calling terminal") }
guard responsible != nil else { fail("responsibility_get_pid_responsible_for_pid is unavailable") }
let mode = args[2]
let appURL = URL(fileURLWithPath: args[1])
var metrics: [String: Double] = ["system_load1_before": loadAverage()]
// Which processes were counted (name and RSS MiB), so totals can be audited.
var counted: [String: [String]] = [:]
func describe(_ samples: [Sample]) -> [String] {
  samples.map { "\($0.name) \(String(format: "%.1f", $0.rssKiB / 1024))" }.sorted()
}

let configuration = NSWorkspace.OpenConfiguration()
configuration.createsNewApplicationInstance = true
configuration.activates = true
var launched: NSRunningApplication?
var launchError: Error?
let launchLock = NSLock()
let launchStart = elapsedMs()
NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { app, error in
  launchLock.lock(); launched = app; launchError = error; launchLock.unlock()
}
func launchedApp() -> NSRunningApplication? { launchLock.lock(); defer { launchLock.unlock() }; return launched }
guard spin(until: launchStart + 20_000, { launchedApp() != nil || launchError != nil }), let app = launchedApp() else {
  fail("launch failed: \(String(describing: launchError))")
}
let pid = app.processIdentifier

func quit() {
  app.terminate()
  if !spin(until: elapsedMs() + 5_000, every: 20, { app.isTerminated }) {
    app.forceTerminate()
    _ = spin(until: elapsedMs() + 3_000, every: 20, { app.isTerminated })
    metrics["force_terminated"] = 1
  }
  // Any surviving child (e.g. the PTY shell) would be a cleanup bug; report it.
  _ = spin(until: elapsedMs() + 2_000, every: 50, { processFamily(of: pid).isEmpty })
  metrics["leftover_processes"] = Double(processFamily(of: pid).count)
}

metrics["launch_callback_ms"] = elapsedMs() - launchStart
guard spin(until: launchStart + 30_000, { hasWindow(pid) }) else { quit(); fail("no on-screen window within 30 s") }
metrics["window_ms"] = elapsedMs() - launchStart

if mode == "startup" {
  var button: AXUIElement?
  if spin(until: launchStart + 30_000, every: 25, { button = findButton(pid, label: "本地终端"); return button != nil }) {
    metrics["ui_button_ms"] = elapsedMs() - launchStart
  }
} else {
  sleepUntil(launchStart + 10_000)
  let idle10 = processFamily(of: pid)
  // Background (not frontmost) apps may be throttled by App Nap; record it.
  metrics["idle10s_frontmost"] = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid ? 1 : 0
  sleepUntil(launchStart + 20_000)
  let idle20 = processFamily(of: pid)
  for (key, value) in summary(idle10, app: pid) { metrics["idle10s_\(key)"] = value }
  counted["idle10s"] = describe(idle10)
  metrics["idle10to20s_cpu_total_pct"] = windowCpu(idle10, idle20, seconds: 10)
  metrics["idle20s_rss_total_mib"] = summary(idle20, app: pid)["rss_total_mib"]
  // WebKit builds its accessibility tree lazily on the first AX request, so
  // retry for a bounded time instead of trusting a single traversal.
  metrics["idle20s_frontmost"] = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid ? 1 : 0
  let lookup = elapsedMs()
  var found: AXUIElement?
  _ = spin(until: lookup + 10_000, every: 100) { found = findButton(pid, label: "本地终端"); return found != nil }
  guard let button = found else {
    var role: AnyObject?
    let status = AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXRoleAttribute as CFString, &role)
    let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    quit()
    fail("button not found through AX after 10 s; visited=\(lastAxVisited) roles=\(lastAxRoles) rootError=\(status.rawValue) frontmost=\(frontmost)")
  }
  metrics["ax_lookup_ms"] = elapsedMs() - lookup
  let press = elapsedMs()
  guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { quit(); fail("AX press failed") }
  if spin(until: press + 10_000, every: 5, { processFamily(of: pid).contains { $0.name.hasSuffix("zsh") } }) {
    metrics["press_to_shell_process_ms"] = elapsedMs() - press
  }
  sleepUntil(press + 10_000)
  let term10 = processFamily(of: pid)
  sleepUntil(press + 20_000)
  let term20 = processFamily(of: pid)
  for (key, value) in summary(term10, app: pid) { metrics["terminal10s_\(key)"] = value }
  counted["terminal10s"] = describe(term10)
  metrics["terminal10to20s_cpu_total_pct"] = windowCpu(term10, term20, seconds: 10)
  metrics["terminal10s_shell_processes"] = Double(term10.filter { $0.name.hasSuffix("zsh") }.count)
}
metrics["system_load1_after"] = loadAverage()
quit()
let line: [String: Any] = [
  "group": "app-\(mode)", "metrics": metrics, "counted": counted, "pid": Int(pid),
  "at": ISO8601DateFormatter().string(from: Date()),
]
let json = try JSONSerialization.data(withJSONObject: line, options: [.sortedKeys])
print(String(decoding: json, as: UTF8.self))
