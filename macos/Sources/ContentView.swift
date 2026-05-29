import SwiftUI
import AppKit
import UniformTypeIdentifiers

@MainActor
final class ReepubModel: ObservableObject {
    @Published var isProcessing = false
    @Published var status = "選一個 PDF 開始"
    @Published var progressText = ""
    @Published var summary: String?
    @Published var preview = ""

    func pickPDF() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.pdf]
        panel.allowsMultipleSelection = false
        panel.message = "選擇要數位化的 PDF（你擁有或有權數位化的檔案）"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        run(url: url)
    }

    private func run(url: URL) {
        isProcessing = true
        summary = nil
        preview = ""
        status = "辨識中…"
        progressText = ""

        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                let pages = try OCREngine.recognize(pdfURL: url) { current, total in
                    Task { @MainActor in self?.progressText = "OCR 第 \(current)/\(total) 頁…" }
                }
                await self?.finish(pages: pages, name: url.lastPathComponent)
            } catch {
                await self?.fail(error)
            }
        }
    }

    private func finish(pages: [OCRPage], name: String) {
        let textPages = pages.filter { $0.type == "text" }.count
        let imagePages = pages.filter { $0.type == "image" }.count
        let totalChars = pages.reduce(0) { $0 + $1.lines.reduce(0) { $0 + $1.text.count } }

        summary = "\(name)\n共 \(pages.count) 頁 · 文字頁 \(textPages) · 圖片頁 \(imagePages) · 辨識 \(totalChars) 字"
        if let firstText = pages.first(where: { $0.type == "text" }) {
            preview = firstText.lines.prefix(14).map { $0.text }.joined(separator: "\n")
        }
        status = "完成"
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
        VStack(spacing: 16) {
            Text("Reepub")
                .font(.system(size: 40, weight: .bold, design: .rounded))
            Text("把你的紙，裝幀成私人電子書庫")
                .font(.title3)
                .foregroundStyle(.secondary)

            Button(action: model.pickPDF) {
                Label("選擇 PDF…", systemImage: "doc.viewfinder")
            }
            .controlSize(.large)
            .disabled(model.isProcessing)
            .padding(.top, 4)

            if model.isProcessing {
                ProgressView().controlSize(.small)
            }
            if !model.progressText.isEmpty {
                Text(model.progressText).font(.callout).foregroundStyle(.secondary)
            }
            Text(model.status).font(.headline)

            if let summary = model.summary {
                Text(summary)
                    .font(.callout)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.green)
            }
            if !model.preview.isEmpty {
                ScrollView {
                    Text(model.preview)
                        .font(.system(.caption, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(10)
                }
                .frame(height: 180)
                .background(Color.primary.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .frame(width: 540, height: 520)
        .padding(30)
    }
}
