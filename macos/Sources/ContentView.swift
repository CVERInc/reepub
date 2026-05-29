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
    @Published var isDropTargeted = false
    @Published var bookTitle = ""
    @Published var bookAuthor = ""

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

    func handleDroppedPDF(_ url: URL) {
        guard url.pathExtension.lowercased() == "pdf" else {
            status = "請拖入 PDF 檔案"
            return
        }
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
        bookTitle = sourceName
        bookAuthor = ""
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
        let title = bookTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveTitle = title.isEmpty ? sourceName : title

        let panel = NSSavePanel()
        if let epubType = UTType(filenameExtension: "epub") {
            panel.allowedContentTypes = [epubType]
        }
        panel.nameFieldStringValue = "\(effectiveTitle).epub"
        panel.canCreateDirectories = true
        panel.message = "選擇 EPUB 儲存位置"
        guard panel.runModal() == .OK, let url = panel.url else { return }

        let metadata = EpubMetadata(title: effectiveTitle,
                                    author: bookAuthor.trimmingCharacters(in: .whitespacesAndNewlines))
        let pagesCopy = pages
        isProcessing = true
        savedURL = nil
        status = "組裝 EPUB 中…"

        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                try EpubBuilder.build(pages: pagesCopy, metadata: metadata, outputURL: url) { stage in
                    Task { @MainActor in self?.progressText = stage }
                }
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
        progressText = ""
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

                if !model.canSave && !model.isProcessing {
                    Text("或將 PDF 拖放到視窗")
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(.white.opacity(0.55))
                }

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

                if model.canSave {
                    VStack(spacing: 10) {
                        field("書名／標題", text: $model.bookTitle, placeholder: "預設使用檔名")
                        field("作者／來源（選填）", text: $model.bookAuthor, placeholder: "可留空")
                    }
                    .frame(maxWidth: 360)
                    .disabled(model.isProcessing)
                    .padding(.top, 2)
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
                    .frame(height: 150)
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
        .frame(width: 560, height: 660)
        .overlay {
            if model.isDropTargeted {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Brand.mint, style: StrokeStyle(lineWidth: 3, dash: [10, 6]))
                    .padding(8)
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first(where: { $0.pathExtension.lowercased() == "pdf" }) else { return false }
            model.handleDroppedPDF(url)
            return true
        } isTargeted: { model.isDropTargeted = $0 }
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.7))
            TextField(placeholder, text: text)
                .textFieldStyle(.plain)
                .font(.system(size: 14, design: .rounded))
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        }
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
