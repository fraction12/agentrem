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

// When launched via `open -a ... --args <path>`, the path may be in
// ProcessInfo arguments (after the executable name)
let args = ProcessInfo.processInfo.arguments
var jsonPath: String? = nil
for i in 1..<args.count {
    if args[i].hasSuffix(".json") || args[i].hasPrefix("/tmp/") {
        jsonPath = args[i]
        break
    }
}

// Parse payload if a JSON path was provided (nil when relaunched for action handling)
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

// ── Set up as proper NSApplication (required for UNUserNotificationCenter) ───

class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let payload: NotifyPayload?
    var timeoutWorkItem: DispatchWorkItem?

    init(payload: NotifyPayload?) {
        self.payload = payload
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
            // Create parent dirs if needed
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

    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        // Register the "Complete ✅" action category so macOS shows the button.
        // .foreground ensures the app is brought to foreground on tap, making
        // the didReceive callback fire reliably even after relaunch.
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

        if payload != nil {
            // Normal launch: request permission then fire the notification
            center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
                if let error = error {
                    fputs("agentrem-notify: auth error: \(error.localizedDescription)\n", stderr)
                    NSApp.terminate(nil)
                    return
                }
                guard granted else {
                    fputs("agentrem-notify: notification permission not granted\n", stderr)
                    NSApp.terminate(nil)
                    return
                }
                self.postNotification()
            }
        }
        // else: relaunched to handle an action or URL — wait for the delegate callback

        // Stay alive long enough for user to interact with the notification.
        // macOS dismisses the banner after ~5s but the notification stays in
        // Notification Center. We keep alive for 5 minutes so tapping it later
        // still works. The didReceive handler terminates early on action.
        scheduleTimeout(seconds: 300.0)
    }

    func scheduleTimeout(seconds: Double) {
        let work = DispatchWorkItem {
            NSApp.terminate(nil)
        }
        timeoutWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    func postNotification() {
        guard let payload = payload else { return }

        let content = UNMutableNotificationContent()
        content.title = payload.title
        content.body = payload.message
        if let sub = payload.subtitle { content.subtitle = sub }
        if let snd = payload.sound {
            content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: snd))
        } else {
            content.sound = .default
        }

        // Attach category so the "Complete ✅" button appears
        content.categoryIdentifier = "AGENTREM_REMINDER"

        // Pass reminderId (and URL scheme backup) so we can call `agentrem complete`
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
                NSApp.terminate(nil)
            }
            // Stay alive for 10 s to handle an immediate action tap;
            // the timeout scheduled in applicationDidFinishLaunching covers this.
        }
    }

    // ── URL scheme handler (agentrem://complete/<reminderId>) ─────────────────

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            log("application:open URL=\(url.absoluteString)")
            guard url.scheme == "agentrem",
                  url.host == "complete" else {
                log("Unrecognised URL, ignoring: \(url.absoluteString)")
                continue
            }
            // Path is "/<reminderId>" — strip leading slash
            let reminderId = url.path.hasPrefix("/")
                ? String(url.path.dropFirst())
                : url.path
            guard !reminderId.isEmpty else {
                log("URL missing reminderId: \(url.absoluteString)")
                continue
            }
            runComplete(reminderId: reminderId)
        }
        timeoutWorkItem?.cancel()
        NSApp.terminate(nil)
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
            timeoutWorkItem?.cancel()
            NSApp.terminate(nil)

        case UNNotificationDefaultActionIdentifier:
            // Default tap — macOS auto-dismisses, so re-deliver the notification
            log("Default tap — re-delivering notification")
            let original = response.notification.request.content
            let newContent = UNMutableNotificationContent()
            newContent.title = original.title
            newContent.body = original.body
            newContent.subtitle = original.subtitle
            newContent.sound = nil  // Don't re-sound
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
            // Dismiss action (swipe away) or unknown
            log("Dismissed or unknown action: \(response.actionIdentifier)")
            completionHandler()
        }
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
