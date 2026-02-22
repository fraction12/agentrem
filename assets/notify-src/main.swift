import Cocoa
import UserNotifications

// ── Payload ──────────────────────────────────────────────────────────────────

struct NotifyPayload: Decodable {
    let title: String
    let subtitle: String?
    let message: String
    let sound: String?
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

guard let path = jsonPath else {
    fputs("agentrem-notify: usage: open -a Agentrem.app --args <json-file>\n", stderr)
    exit(1)
}

guard let fileData = try? Data(contentsOf: URL(fileURLWithPath: path)),
      let payload = try? JSONDecoder().decode(NotifyPayload.self, from: fileData) else {
    fputs("agentrem-notify: failed to read or decode \(path)\n", stderr)
    exit(1)
}

// ── Set up as proper NSApplication (required for UNUserNotificationCenter) ───

class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let payload: NotifyPayload
    
    init(payload: NotifyPayload) {
        self.payload = payload
        super.init()
    }
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        
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
    
    func postNotification() {
        let content = UNMutableNotificationContent()
        content.title = payload.title
        content.body = payload.message
        if let sub = payload.subtitle { content.subtitle = sub }
        if let snd = payload.sound {
            content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: snd))
        } else {
            content.sound = .default
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
            // Give the notification a moment to display
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                NSApp.terminate(nil)
            }
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
let delegate = AppDelegate(payload: payload)
app.delegate = delegate
app.run()
