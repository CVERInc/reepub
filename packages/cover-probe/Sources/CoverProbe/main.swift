// CoverProbe — render an HTML file offscreen with WKWebView and write a PNG.
// A probe, not a product: it exists to measure whether WKWebView lays this
// cover out the same way Chromium does, before anything is ported.
import Foundation
import WebKit
import AppKit

let args = CommandLine.arguments
guard args.count >= 5 else {
    FileHandle.standardError.write("Usage: CoverProbe <html> <out.png> <width> <height>\n".data(using: .utf8)!)
    exit(1)
}
let htmlURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])
let w = Double(args[3])!, h = Double(args[4])!

final class Shooter: NSObject, WKNavigationDelegate {
    let web: WKWebView
    let out: URL
    init(out: URL, size: CGSize) {
        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: CGRect(origin: .zero, size: size), configuration: cfg)
        self.out = out
        super.init()
        web.navigationDelegate = self
    }
    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        // Fonts and layout settle a frame after load; snapshotting immediately
        // catches an unlaid-out page, which would make any diff meaningless.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            let cfg = WKSnapshotConfiguration()
            cfg.rect = CGRect(origin: .zero, size: w.frame.size)
            w.takeSnapshot(with: cfg) { image, err in
                guard let image, err == nil else {
                    FileHandle.standardError.write("snapshot failed: \(err?.localizedDescription ?? "nil")\n".data(using: .utf8)!)
                    exit(1)
                }
                guard let tiff = image.tiffRepresentation,
                      let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
                try? png.write(to: self.out)
                exit(0)
            }
        }
    }
    func webView(_ w: WKWebView, didFail nav: WKNavigation!, withError e: Error) { exit(1) }
}

let shooter = Shooter(out: outURL, size: CGSize(width: w, height: h))
let html = try String(contentsOf: htmlURL, encoding: .utf8)
shooter.web.loadHTMLString(html, baseURL: htmlURL.deletingLastPathComponent())
RunLoop.main.run()
