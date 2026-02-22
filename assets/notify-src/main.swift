import Cocoa
import UserNotifications

// ── Payload ──────────────────────────────────────────────────────────────────

struct NotifyPayload: Decodable {
    let title: String
    let subtitle: String?
    let message: String
    let sound: String?
    let reminderId: String?
}

// ── Read JSON file from argv[1] or process args ──────────────────────────────

let args = ProcessInfo.processInfo.arguments
var jsonPath: String? = nil
for i in 1..<args.count {
    if args[i].hasSuffix(".json") || args[i].hasPrefix("/tmp/") {
        jsonPath = args[i]
        break
    }
}

var parsedPayload: NotifyPayload? = nil
if let path = jsonPath {
    if let fileData = try? Data(contentsOf: URL(fileURLWithPath: path)),
       let decoded = try? JSONDecoder().decode(NotifyPayload.self, from: fileData) {
        parsedPayload = decoded
    } else {
        fputs("agentrem-notify: failed to read or decode \(path)\n", stderr)
        exit(1)
    }
}

// ── Singleton check: if another instance is running, forward via IPC ─────────

let lockPath = NSHomeDirectory() + "/.agentrem/notify.lock"

func isAnotherInstanceRunning() -> Bool {
    // Check for PID file
    guard let pidStr = try? String(contentsOfFile: lockPath, encoding: .utf8),
          let pid = Int32(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)) else {
        return false
    }
    // Check if that PID is actually alive
    return kill(pid, 0) == 0
}

func writePidFile() {
    let dir = NSHomeDirectory() + "/.agentrem"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    try? "\(ProcessInfo.processInfo.processIdentifier)".write(toFile: lockPath, atomically: true, encoding: .utf8)
}

func removePidFile() {
    try? FileManager.default.removeItem(atPath: lockPath)
}

// If another instance is running and we have a payload, forward it via DistributedNotification
if let payload = parsedPayload, isAnotherInstanceRunning() {
    // Encode payload as JSON and send via distributed notification
    if let data = try? JSONEncoder().encode(payload),
       let jsonStr = String(data: data, encoding: .utf8) {
        DistributedNotificationCenter.default().postNotificationName(
            NSNotification.Name("com.agentrem.newNotification"),
            object: nil,
            userInfo: ["json": jsonStr],
            deliverImmediately: true
        )
    }
    // Give it a moment to deliver
    Thread.sleep(forTimeInterval: 0.2)
    exit(0)
}

// ── We are the primary instance ──────────────────────────────────────────────

extension NotifyPayload: Encodable {}

class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let initialPayload: NotifyPayload?
    var activityTimeout: DispatchWorkItem?

    init(payload: NotifyPayload?) {
        self.initialPayload = payload
        super.init()
    }

    // ── Shared logging ────────────────────────────────────────────────────────

    func log(_ msg: String) {
        let logPath = NSHomeDirectory() + "/.agentrem/logs/notify-actions.log"
        let ts = ISO8601DateFormatter().string(from: Date())
        let line = "[\(ts)] \(msg)\n"
        if let fh = FileHandle(forWritingAtPath: logPath) {
            fh.seekToEndOfFile()
            fh.write(line.data(using: .utf8)!)
            fh.closeFile()
        } else {
            try? FileManager.default.createDirectory(
                atPath: NSHomeDirectory() + "/.agentrem/logs",
                withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: logPath, contents: line.data(using: .utf8))
        }
    }

    // ── Run `agentrem complete <reminderId>` ──────────────────────────────────

    func runComplete(reminderId: String) {
        log("Running: agentrem complete \(reminderId)")
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/node")
        proc.arguments = ["/opt/homebrew/lib/node_modules/agentrem/dist/index.js", "complete", reminderId]
        proc.environment = ["HOME": NSHomeDirectory(), "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"]
        do {
            try proc.run()
            proc.waitUntilExit()
            log("Complete exited with code \(proc.terminationStatus)")
        } catch {
            log("ERROR running complete: \(error.localizedDescription)")
        }
    }

    // ── Reset the inactivity timeout (extends lifetime on each notification) ──

    func resetTimeout() {
        activityTimeout?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.log("Timeout — no activity for 10 minutes, shutting down")
            removePidFile()
            NSApp.terminate(nil)
        }
        activityTimeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 600.0, execute: work)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        writePidFile()

        let center = UNUserNotificationCenter.current()
        center.delegate = self

        // Register "Complete ✅" action
        let completeAction = UNNotificationAction(
            identifier: "COMPLETE_REMINDER",
            title: "Complete ✅",
            options: []
        )
        let category = UNNotificationCategory(
            identifier: "AGENTREM_REMINDER",
            actions: [completeAction],
            intentIdentifiers: [],
            options: []
        )
        center.setNotificationCategories([category])

        // Listen for forwarded notifications from new instances
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(handleForwardedNotification(_:)),
            name: NSNotification.Name("com.agentrem.newNotification"),
            object: nil
        )

        if initialPayload != nil {
            center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
                if let error = error {
                    fputs("agentrem-notify: auth error: \(error.localizedDescription)\n", stderr)
                    removePidFile()
                    NSApp.terminate(nil)
                    return
                }
                guard granted else {
                    fputs("agentrem-notify: notification permission not granted\n", stderr)
                    removePidFile()
                    NSApp.terminate(nil)
                    return
                }
                self.postNotification(self.initialPayload!)
            }
        }

        resetTimeout()
    }

    func applicationWillTerminate(_ notification: Notification) {
        removePidFile()
    }

    // ── Handle forwarded notification from another instance ───────────────────

    @objc func handleForwardedNotification(_ notif: Notification) {
        log("Received forwarded notification via IPC")
        guard let jsonStr = notif.userInfo?["json"] as? String,
              let data = jsonStr.data(using: .utf8),
              let payload = try? JSONDecoder().decode(NotifyPayload.self, from: data) else {
            log("Failed to decode forwarded notification")
            return
        }
        postNotification(payload)
        resetTimeout()
    }

    func postNotification(_ payload: NotifyPayload) {
        let content = UNMutableNotificationContent()
        content.title = payload.title
        content.body = payload.message
        if let sub = payload.subtitle { content.subtitle = sub }
        if let snd = payload.sound {
            content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: snd))
        } else {
            content.sound = .default
        }

        content.categoryIdentifier = "AGENTREM_REMINDER"

        if let reminderId = payload.reminderId {
            content.userInfo = [
                "reminderId": reminderId,
                "url": "agentrem://complete/\(reminderId)"
            ]
        }

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )

        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                fputs("agentrem-notify: post error: \(error.localizedDescription)\n", stderr)
            }
        }
    }

    // ── URL scheme handler ────────────────────────────────────────────────────

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            log("application:open URL=\(url.absoluteString)")
            guard url.scheme == "agentrem", url.host == "complete" else {
                log("Unrecognised URL, ignoring: \(url.absoluteString)")
                continue
            }
            let reminderId = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
            guard !reminderId.isEmpty else {
                log("URL missing reminderId: \(url.absoluteString)")
                continue
            }
            runComplete(reminderId: reminderId)
        }
    }

    // ── Action handler ────────────────────────────────────────────────────────

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        log("didReceive action=\(response.actionIdentifier) userInfo=\(response.notification.request.content.userInfo)")

        switch response.actionIdentifier {
        case "COMPLETE_REMINDER":
            if let reminderId = response.notification.request.content.userInfo["reminderId"] as? String,
               !reminderId.isEmpty {
                runComplete(reminderId: reminderId)
            } else {
                log("No reminderId in userInfo")
            }
            completionHandler()

        case UNNotificationDefaultActionIdentifier:
            // Default tap — macOS auto-dismisses, so re-deliver silently
            log("Default tap — re-delivering notification")
            let original = response.notification.request.content
            let newContent = UNMutableNotificationContent()
            newContent.title = original.title
            newContent.body = original.body
            newContent.subtitle = original.subtitle
            newContent.sound = nil  // No re-sound
            newContent.categoryIdentifier = original.categoryIdentifier
            newContent.userInfo = original.userInfo
            let req = UNNotificationRequest(
                identifier: UUID().uuidString,
                content: newContent,
                trigger: UNTimeIntervalNotificationTrigger(timeInterval: 0.5, repeats: false)
            )
            center.add(req) { error in
                if let error = error {
                    self.log("Re-deliver failed: \(error.localizedDescription)")
                }
            }
            completionHandler()

        default:
            log("Dismissed or unknown action: \(response.actionIdentifier)")
            completionHandler()
        }

        resetTimeout()
    }

    // Show notification even when app is in foreground
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // No dock icon
let delegate = AppDelegate(payload: parsedPayload)
app.delegate = delegate
app.run()
