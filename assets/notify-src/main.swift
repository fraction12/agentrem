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

    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        // Register the "Complete ✅" action category so macOS shows the button
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
        // else: relaunched to handle an action — just wait for the delegate callback

        // Terminate after 5 s whether or not we handle an action
        scheduleTimeout(seconds: 5.0)
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

        // Pass reminderId so we can call `agentrem complete` when tapped
        if let reminderId = payload.reminderId {
            content.userInfo = ["reminderId": reminderId]
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
            // Stay alive for 5 s to handle an immediate action tap;
            // the timeout scheduled in applicationDidFinishLaunching covers this.
        }
    }

    // ── Action handler ────────────────────────────────────────────────────────

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == "COMPLETE_REMINDER" {
            if let reminderId = response.notification.request.content.userInfo["reminderId"] as? String,
               !reminderId.isEmpty {
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/agentrem")
                proc.arguments = ["complete", reminderId]
                do {
                    try proc.run()
                    proc.waitUntilExit()
                } catch {
                    fputs("agentrem-notify: failed to run agentrem complete: \(error.localizedDescription)\n", stderr)
                }
            }
        }
        completionHandler()
        timeoutWorkItem?.cancel()
        NSApp.terminate(nil)
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
