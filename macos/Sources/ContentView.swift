import SwiftUI
import AppKit
import UniformTypeIdentifiers

// CVER OSS palette (from the bleedblend demo: --demo-grad-bot / --demo-belt / --demo-grad-top).
extension Color {
    init(hex: String) {
        let cleaned = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        var rgb: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&rgb)
        self.init(.sRGB,
                  red: Double((rgb >> 16) & 0xff) / 255,
                  green: Double((rgb >> 8) & 0xff) / 255,
                  blue: Double(rgb & 0xff) / 255,
                  opacity: 1)
    }
}

enum Brand {
    static let teal = Color(hex: "#0a8c8e")
    static let darkTeal = Color(hex: "#084a4c")
    static let mint = Color(hex: "#aceace")
}

@MainActor
final class ReepubModel: ObservableObject {
    @Published var isProcessing = false
    @Published var status = "選一個 PDF 開始"
    @Published var progressText = ""
    @Published var summary: String?
    @Published var preview = ""
    @Published var canSave = false
    @Published var savedURL: URL?

    private var pages: [OCRPage] = []
    private var sourceName = "book"

    func pickPDF() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.pdf]
        panel.allowsMultipleSelection = false
        panel.message = "選擇要數位化的 PDF（你擁有或有權數位化的檔案）"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        runOCR(url: url)
    }

    private func runOCR(url: URL) {
        isProcessing = true
        canSave = false
        savedURL = nil
        summary = nil
        preview = ""
        pages = []
        sourceName = url.deletingPathExtension().lastPathComponent
        status = "辨識中…"
        progressText = ""

        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                let pages = try OCREngine.recognize(pdfURL: url) { current, total in
                    Task { @MainActor in self?.progressText = "OCR 第 \(current)/\(total) 頁…" }
                }
                await self?.ocrFinished(pages: pages, name: url.lastPathComponent)
            } catch {
                await self?.fail(error)
            }
        }
    }

    private func ocrFinished(pages: [OCRPage], name: String) {
        self.pages = pages
        let textPages = pages.filter { $0.type == "text" }.count
        let imagePages = pages.filter { $0.type == "image" }.count
        let totalChars = pages.reduce(0) { $0 + $1.lines.reduce(0) { $0 + $1.text.count } }

        summary = "\(name)\n共 \(pages.count) 頁 · 文字頁 \(textPages) · 圖片頁 \(imagePages) · 辨識 \(totalChars) 字"
        if let firstText = pages.first(where: { $0.type == "text" }) {
            preview = firstText.lines.prefix(14).map { $0.text }.joined(separator: "\n")
        }
        status = "辨識完成 — 可存成 EPUB"
        progressText = ""
        canSave = true
        isProcessing = false
    }

    func saveEpub() {
        guard !pages.isEmpty else { return }
        let panel = NSSavePanel()
        if let epubType = UTType(filenameExtension: "epub") {
            panel.allowedContentTypes = [epubType]
        }
        panel.nameFieldStringValue = "\(sourceName).epub"
        panel.canCreateDirectories = true
        panel.message = "選擇 EPUB 儲存位置"
        guard panel.runModal() == .OK, let url = panel.url else { return }

        let metadata = EpubMetadata(title: url.deletingPathExtension().lastPathComponent, author: "")
        let pagesCopy = pages
        isProcessing = true
        savedURL = nil
        status = "組裝 EPUB 中…"

        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                try EpubBuilder.build(pages: pagesCopy, metadata: metadata, outputURL: url)
                await self?.saveFinished(url: url)
            } catch {
                await self?.fail(error)
            }
        }
    }

    func revealInFinder() {
        guard let url = savedURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    private func saveFinished(url: URL) {
        savedURL = url
        status = "已儲存：\(url.lastPathComponent)"
        isProcessing = false
    }

    private func fail(_ error: Error) {
        status = "錯誤：\(error.localizedDescription)"
        progressText = ""
        isProcessing = false
    }
}

struct ContentView: View {
    @StateObject private var model = ReepubModel()

    var body: some View {
        ZStack {
            LinearGradient(colors: [Brand.teal, Brand.darkTeal],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()

            VStack(spacing: 14) {
                Text("Reepub")
                    .font(.system(size: 46, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.15), radius: 8, y: 2)

                Text("把你的紙，裝幀成私人電子書庫")
                    .font(.system(size: 15, weight: .regular, design: .rounded))
                    .foregroundStyle(.white.opacity(0.82))

                HStack(spacing: 12) {
                    pillButton(title: "選擇 PDF…", systemImage: "doc.viewfinder",
                               filled: !model.canSave, action: model.pickPDF)
                    if model.canSave {
                        pillButton(title: "存成 EPUB…", systemImage: "books.vertical",
                                   filled: true, action: model.saveEpub)
                    }
                }
                .disabled(model.isProcessing)
                .opacity(model.isProcessing ? 0.55 : 1)
                .padding(.top, 6)

                if model.isProcessing {
                    ProgressView().controlSize(.small).tint(.white)
                }
                if !model.progressText.isEmpty {
                    Text(model.progressText)
                        .font(.system(size: 13, design: .rounded))
                        .foregroundStyle(.white.opacity(0.7))
                }
                Text(model.status)
                    .font(.system(size: 16, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)

                if model.savedURL != nil {
                    Button("在 Finder 顯示", action: model.revealInFinder)
                        .buttonStyle(.plain)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(Brand.mint)
                }

                if let summary = model.summary {
                    Text(summary)
                        .font(.system(size: 13, design: .rounded))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Brand.mint)
                }
                if !model.preview.isEmpty {
                    ScrollView {
                        Text(model.preview)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.9))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .padding(12)
                    }
                    .frame(height: 170)
                    .background(.white.opacity(0.05))
                    .overlay(
                        RoundedRectangle(cornerRadius: 18)
                            .stroke(.white.opacity(0.08), lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 18))
                }
            }
            .padding(40)
        }
        .frame(width: 560, height: 620)
    }

    private func pillButton(title: String, systemImage: String,
                            filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(filled ? Brand.darkTeal : .white)
                .padding(.horizontal, 22)
                .padding(.vertical, 12)
                .background {
                    if filled {
                        Capsule().fill(Brand.mint)
                    } else {
                        Capsule().stroke(.white.opacity(0.5), lineWidth: 1.5)
                    }
                }
        }
        .buttonStyle(.plain)
    }
}
