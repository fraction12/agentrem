import Foundation
import UserNotifications

// ── Payload ──────────────────────────────────────────────────────────────────

struct NotifyPayload: Decodable {
    let title: String
    let subtitle: String?
    let message: String
    let sound: String?
}

// ── Read JSON file from argv[1] ───────────────────────────────────────────────

guard CommandLine.arguments.count > 1 else {
    fputs("agentrem-notify: usage: agentrem-notify <json-file>\n", stderr)
    exit(1)
}

let jsonPath = CommandLine.arguments[1]

guard let fileData = try? Data(contentsOf: URL(fileURLWithPath: jsonPath)),
      let payload = try? JSONDecoder().decode(NotifyPayload.self, from: fileData) else {
    fputs("agentrem-notify: failed to read or decode \(jsonPath)\n", stderr)
    exit(1)
}

// ── Post via UNUserNotificationCenter ─────────────────────────────────────────
// Must run on a background thread so the main RunLoop (required by UNUserNotif-
// icationCenter) can keep spinning while we await the async callbacks.

let center = UNUserNotificationCenter.current()

DispatchQueue.global().async {
    // --- request authorization (first run shows the system prompt) ----------
    let authSema = DispatchSemaphore(value: 0)
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
        defer { authSema.signal() }

        if let error = error {
            fputs("agentrem-notify: auth error: \(error.localizedDescription)\n", stderr)
            return
        }

        guard granted else {
            fputs("agentrem-notify: notification permission not granted\n", stderr)
            return
        }

        // --- build and post the notification --------------------------------
        let content = UNMutableNotificationContent()
        content.title   = payload.title
        content.body    = payload.message
        if let sub = payload.subtitle { content.subtitle = sub }
        if let snd = payload.sound {
            content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: snd))
        } else {
            content.sound = .default
        }

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil  // deliver immediately
        )

        let postSema = DispatchSemaphore(value: 0)
        center.add(request) { err in
            if let err = err {
                fputs("agentrem-notify: post error: \(err.localizedDescription)\n", stderr)
            }
            postSema.signal()
        }
        postSema.wait()
    }
    authSema.wait()

    // Brief pause to let the notification be displayed before we exit
    Thread.sleep(forTimeInterval: 0.5)
    exit(0)
}

// Keep the main RunLoop alive — UNUserNotificationCenter requires it
RunLoop.main.run()
