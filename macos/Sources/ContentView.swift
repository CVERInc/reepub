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
    @Published var status = ""
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
    private let loc: Localizer

    // Raw building blocks so localized text can be re-rendered when the
    // language changes mid-session (the @Published `status`/`summary` strings
    // are recomputed from these by `relocalize()`).
    private enum StatusState {
        case start, recognizing, ocrDone, assembling
        case saved(String)
        case droppedNonPDF
        case error(String)
    }
    private var statusState: StatusState = .start
    private var ocrCounts: (pages: Int, text: Int, image: Int, chars: Int)?

    init(loc: Localizer) {
        self.loc = loc
        self.status = loc(.statusStart)
    }

    /// Re-render all localized model output for the current language.
    func relocalize() {
        switch statusState {
        case .start:         status = loc(.statusStart)
        case .recognizing:   status = loc(.statusRecognizing)
        case .ocrDone:       status = loc(.statusOCRDone)
        case .assembling:    status = loc(.statusAssembling)
        case .saved(let n):  status = loc(.statusSavedPrefix) + n
        case .droppedNonPDF: status = loc(.statusDropPDF)
        case .error(let m):  status = loc(.statusErrorPrefix) + m
        }
        if let c = ocrCounts {
            summary = summaryText(name: sourceName, c: c)
        }
    }

    private func summaryText(name: String,
                             c: (pages: Int, text: Int, image: Int, chars: Int)) -> String {
        let parts = [
            String(format: loc(.summaryTotalPages), c.pages),
            String(format: loc(.summaryTextPages), c.text),
            String(format: loc(.summaryImagePages), c.image),
            String(format: loc(.summaryChars), c.chars),
        ]
        return "\(name)\n" + parts.joined(separator: " · ")
    }

    func pickPDF() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.pdf]
        panel.allowsMultipleSelection = false
        panel.message = loc(.openPanelMessage)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        runOCR(url: url)
    }

    func handleDroppedPDF(_ url: URL) {
        guard url.pathExtension.lowercased() == "pdf" else {
            statusState = .droppedNonPDF
            status = loc(.statusDropPDF)
            return
        }
        runOCR(url: url)
    }

    private func runOCR(url: URL) {
        isProcessing = true
        canSave = false
        savedURL = nil
        summary = nil
        ocrCounts = nil
        preview = ""
        pages = []
        sourceName = url.deletingPathExtension().lastPathComponent
        bookTitle = sourceName
        bookAuthor = ""
        statusState = .recognizing
        status = loc(.statusRecognizing)
        progressText = ""

        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                let pages = try OCREngine.recognize(pdfURL: url) { current, total in
                    Task { @MainActor in
                        guard let self else { return }
                        self.progressText = String(format: self.loc(.progressOCRPage), current, total)
                    }
                }
                await self?.ocrFinished(pages: pages, name: url.deletingPathExtension().lastPathComponent)
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

        let counts = (pages: pages.count, text: textPages, image: imagePages, chars: totalChars)
        ocrCounts = counts
        summary = summaryText(name: name, c: counts)
        if let firstText = pages.first(where: { $0.type == "text" }) {
            preview = firstText.lines.prefix(14).map { $0.text }.joined(separator: "\n")
        }
        statusState = .ocrDone
        status = loc(.statusOCRDone)
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
        panel.message = loc(.savePanelMessage)
        guard panel.runModal() == .OK, let url = panel.url else { return }

        let metadata = EpubMetadata(title: effectiveTitle,
                                    author: bookAuthor.trimmingCharacters(in: .whitespacesAndNewlines))
        let pagesCopy = pages
        isProcessing = true
        savedURL = nil
        statusState = .assembling
        status = loc(.statusAssembling)

        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                try EpubBuilder.build(pages: pagesCopy, metadata: metadata, outputURL: url) { stage in
                    Task { @MainActor in
                        guard let self else { return }
                        self.progressText = self.stageText(stage)
                    }
                }
                await self?.saveFinished(url: url)
            } catch {
                await self?.fail(error)
            }
        }
    }

    private func stageText(_ stage: BuildStage) -> String {
        switch stage {
        case .writingCover:          return loc(.stageWritingCover)
        case .writingChapters(let n): return String(format: loc(.stageWritingChapters), n)
        case .validatingXML:         return loc(.stageValidatingXML)
        case .packaging:             return loc(.stagePackaging)
        }
    }

    func revealInFinder() {
        guard let url = savedURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    private func saveFinished(url: URL) {
        savedURL = url
        statusState = .saved(url.lastPathComponent)
        status = loc(.statusSavedPrefix) + url.lastPathComponent
        progressText = ""
        isProcessing = false
    }

    private func fail(_ error: Error) {
        let message = localizedErrorMessage(error)
        statusState = .error(message)
        status = loc(.statusErrorPrefix) + message
        progressText = ""
        isProcessing = false
    }

    /// Map structured engine errors to localized, formatted messages; fall back
    /// to the system-provided description for anything else.
    private func localizedErrorMessage(_ error: Error) -> String {
        switch error {
        case OCRError.cannotOpenPDF(let name):
            return String(format: loc(.errorCannotOpenPDF), name)
        case EpubError.zipFailed(let m):
            return String(format: loc(.errorZipFailed), m)
        case EpubError.validation(let m):
            return String(format: loc(.errorValidation), m)
        case EpubError.io(let m):
            return String(format: loc(.errorIO), m)
        default:
            return error.localizedDescription
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var loc: Localizer
    @StateObject private var model: ReepubModel

    init(loc: Localizer) {
        _model = StateObject(wrappedValue: ReepubModel(loc: loc))
    }

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

                Text(loc(.tagline))
                    .font(.system(size: 15, weight: .regular, design: .rounded))
                    .foregroundStyle(.white.opacity(0.82))

                HStack(spacing: 12) {
                    pillButton(title: loc(.pickPDF), systemImage: "doc.viewfinder",
                               filled: !model.canSave, action: model.pickPDF)
                    if model.canSave {
                        pillButton(title: loc(.saveEpub), systemImage: "books.vertical",
                                   filled: true, action: model.saveEpub)
                    }
                }
                .disabled(model.isProcessing)
                .opacity(model.isProcessing ? 0.55 : 1)
                .padding(.top, 6)

                if !model.canSave && !model.isProcessing {
                    Text(loc(.dropHint))
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
                    Button(loc(.revealInFinder), action: model.revealInFinder)
                        .buttonStyle(.plain)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(Brand.mint)
                }

                if model.canSave {
                    VStack(spacing: 10) {
                        field(loc(.fieldTitleLabel), text: $model.bookTitle,
                              placeholder: loc(.fieldTitlePlaceholder))
                        field(loc(.fieldAuthorLabel), text: $model.bookAuthor,
                              placeholder: loc(.fieldAuthorPlaceholder))
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
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(.white.opacity(0.08), lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
            }
            .padding(40)

            // Unobtrusive language switcher, top-trailing corner.
            languagePicker
        }
        .frame(width: 560, height: 660)
        .overlay {
            if model.isDropTargeted {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Brand.mint, style: StrokeStyle(lineWidth: 3, dash: [10, 6]))
                    .padding(8)
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first(where: { $0.pathExtension.lowercased() == "pdf" }) else { return false }
            model.handleDroppedPDF(url)
            return true
        } isTargeted: { model.isDropTargeted = $0 }
        // When the language changes, re-render the model's already-emitted text.
        .onChange(of: loc.language) { _ in model.relocalize() }
    }

    /// Compact glass-style language menu pinned to the window's top-trailing corner.
    private var languagePicker: some View {
        VStack {
            HStack {
                Spacer()
                Menu {
                    ForEach(AppLanguage.allCases) { lang in
                        Button {
                            loc.language = lang
                        } label: {
                            if lang == loc.language {
                                Label(lang.displayName, systemImage: "checkmark")
                            } else {
                                Text(lang.displayName)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "globe")
                        Text(loc.language.displayName)
                    }
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.9))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(.white.opacity(0.10), in: Capsule())
                    .overlay(Capsule().stroke(.white.opacity(0.18), lineWidth: 1))
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help(loc(.languageMenuLabel))
            }
            Spacer()
        }
        .padding(16)
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
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
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
