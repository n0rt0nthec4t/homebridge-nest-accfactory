// macOS authentication-session presentation
// Part of homebridge-nest-accfactory
//
// Validate bounded private input, present Google sign-in and return only the
// matching callback through stdout. The parent owns PKCE and token exchange.
// Cancellation, session expiry and window closure retire the same session.

// Define Apple frameworks
import AppKit
import AuthenticationServices
import Foundation

func reply(_ payload: [String: String]) {
    if let bytes = try? JSONSerialization.data(withJSONObject: payload) {
        FileHandle.standardOutput.write(bytes)
    }
}

// Input is a bounded pipe, never a command-line URL or a file containing secrets.
func readInput() -> (URL, String)? {
    var data = Data()
    while let part = try? FileHandle.standardInput.read(upToCount: 4096), !part.isEmpty {
        data.append(part)
        if data.count > 65536 { return nil }
    }
    guard let input = try? JSONSerialization.jsonObject(with: data) as? [String: String],
          let raw = input["url"], let url = URL(string: raw),
          url.scheme == "https", url.host == "accounts.google.com", url.user == nil, url.password == nil,
          url.port == nil || url.port == 443,
          let scheme = input["scheme"],
          scheme.range(of: "^com\\.google\\.sso\\.[A-Za-z0-9.-]+$", options: .regularExpression) != nil
    else { return nil }
    return (url, scheme)
}

@MainActor
final class SessionApp: NSObject, NSApplicationDelegate, NSWindowDelegate, ASWebAuthenticationPresentationContextProviding {
    let url: URL
    let scheme: String
    var window: NSWindow!
    var session: ASWebAuthenticationSession?
    var completed = false
    var timeout: Timer?
    var termination: DispatchSourceSignal?

    init(url: URL, scheme: String) { self.url = url; self.scheme = scheme }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 450, height: 130),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Nest Accfactory Sign-in"
        window.isReleasedWhenClosed = false
        window.delegate = self
        let label = NSTextField(wrappingLabelWithString: "Complete Google sign-in in the system browser.\nClose this window to cancel sign-in.")
        label.frame = NSRect(x: 24, y: 30, width: 402, height: 65)
        window.contentView?.addSubview(label)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        let callback: ASWebAuthenticationSession.CompletionHandler = { [weak self] url, error in

            // Never return localized error descriptions: they can contain URLs.
            DispatchQueue.main.async {
                guard let self else { return }
                if let url {
                    self.finish(["status": "callback", "callback": url.absoluteString])
                } else {
                    let code = (error as NSError?)?.code ?? -1
                    self.finish(["status": code == ASWebAuthenticationSessionError.canceledLogin.rawValue ? "cancelled" : "session_failed"])
                }
            }
        }
        if #available(macOS 14.4, *) {
            session = ASWebAuthenticationSession(url: url, callback: .customScheme(scheme), completionHandler: callback)
        } else {
            session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme, completionHandler: callback)
        }
        session?.presentationContextProvider = self
        session?.prefersEphemeralWebBrowserSession = true
        timeout = Timer.scheduledTimer(withTimeInterval: 900, repeats: false) { [weak self] _ in
            DispatchQueue.main.async { self?.finish(["status": "expired"]) }
        }
        signal(SIGTERM, SIG_IGN)
        termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination?.setEventHandler { [weak self] in self?.finish(["status": "cancelled"]) }
        termination?.resume()
        guard session?.canStart == true, session?.start() == true else {
            finish(["status": "start_failed"])
            return
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window }
    func windowWillClose(_ notification: Notification) { finish(["status": "cancelled"]) }

    func finish(_ result: [String: String]) {
        guard completed == false else { return }
        completed = true
        timeout?.invalidate()
        session?.cancel()
        reply(result)
        NSApp.terminate(nil)
    }
}

// Self-test validates the private pipe and URL boundary without opening a browser.
guard let (url, scheme) = readInput() else { reply(["status": "invalid_input"]); exit(1) }
if CommandLine.arguments.contains("--self-test") {
    reply(["status": "input_valid"])
    exit(0)
}
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = SessionApp(url: url, scheme: scheme)
    app.setActivationPolicy(.regular)
    app.delegate = delegate
    app.run()
}
