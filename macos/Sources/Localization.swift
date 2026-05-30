import Foundation
import Combine

// Self-contained, code-based localization for the native Reepub app.
// No .lproj/.strings bundles — those are awkward with the manual (no-Xcode)
// bundle assembly used by build-app.sh — so the table lives in Swift.
//
// English is the source of truth and the fallback: it MUST contain every key.
// Other locales fall back to English for any missing key. Traditional Chinese
// values are the app's original strings (NEVER converted to Simplified).

// MARK: - Languages

enum AppLanguage: String, CaseIterable, Identifiable {
    // Display order: English / 日本語 / 台灣華語.
    case en
    case ja
    case zhTW

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .en:   return "English"
        case .ja:   return "日本語"
        case .zhTW: return "台灣華語"
        }
    }

    /// Best-effort detection from a BCP-47 tag (e.g. "ja-JP", "zh-Hant-TW").
    /// ja* → .ja; Traditional Chinese variants → .zhTW; everything else → .en.
    static func detected(from tag: String) -> AppLanguage {
        let lower = tag.lowercased()
        if lower.hasPrefix("ja") { return .ja }
        // Traditional Chinese: explicit Hant, or the Traditional-using regions.
        if lower.hasPrefix("zh-hant")
            || lower == "zh-tw" || lower.hasPrefix("zh-tw")
            || lower == "zh-hk" || lower.hasPrefix("zh-hk")
            || lower == "zh-mo" || lower.hasPrefix("zh-mo") {
            return .zhTW
        }
        // zh-Hans* (Simplified) and all others have no dedicated locale → English.
        return .en
    }
}

// MARK: - Keys

/// Strongly-typed keys for every user-facing UI string.
enum LocKey: String, CaseIterable {
    // Header / tagline
    case tagline

    // Buttons / actions
    case pickPDF
    case saveEpub
    case revealInFinder
    case dropHint

    // Open / save panel copy
    case openPanelMessage
    case savePanelMessage

    // Status line
    case statusStart
    case statusRecognizing
    case statusOCRDone
    case statusAssembling
    case statusSavedPrefix      // "Saved: " + filename
    case statusDropPDF
    case statusErrorPrefix      // "Error: " + message

    // Field labels / placeholders
    case fieldTitleLabel
    case fieldTitlePlaceholder
    case fieldAuthorLabel
    case fieldAuthorPlaceholder

    // Summary (after OCR) — assembled with counts
    case summaryTotalPages      // "%d pages"
    case summaryTextPages       // "text %d"
    case summaryImagePages      // "image %d"
    case summaryChars           // "%d chars recognized"

    // Progress (threaded through OCR / build)
    case progressOCRPage        // "OCR page %d/%d…"
    case stageWritingCover
    case stageWritingChapters   // "Writing %d chapters…"
    case stageValidatingXML
    case stagePackaging

    // Errors surfaced from OCREngine / EpubBuilder
    case errorCannotOpenPDF     // "Cannot open PDF: %@"
    case errorZipFailed         // "EPUB packaging failed: %@"
    case errorValidation        // "EPUB validation failed: %@"
    case errorIO                // "Failed to write file: %@"

    // Language switcher
    case languageMenuLabel
}

// MARK: - Localizer

final class Localizer: ObservableObject {
    static let defaultsKey = "appLanguage"

    @Published var language: AppLanguage {
        didSet { UserDefaults.standard.set(language.rawValue, forKey: Self.defaultsKey) }
    }

    init() {
        language = Self.resolveInitialLanguage()
    }

    /// Resolution priority:
    /// 1) a valid persisted override in UserDefaults["appLanguage"];
    /// 2) auto-detect from Locale.preferredLanguages.first;
    /// 3) overall fallback = .en.
    static func resolveInitialLanguage() -> AppLanguage {
        if let saved = UserDefaults.standard.string(forKey: defaultsKey),
           let lang = AppLanguage(rawValue: saved) {
            return lang
        }
        if let preferred = Locale.preferredLanguages.first {
            return AppLanguage.detected(from: preferred)
        }
        return .en
    }

    /// Look up a key in the current language, falling back to English.
    func string(_ key: LocKey) -> String {
        Self.table[language]?[key] ?? Self.table[.en]?[key] ?? key.rawValue
    }

    /// Convenience: `loc(.pickPDF)`.
    func callAsFunction(_ key: LocKey) -> String { string(key) }

    // MARK: Table

    static let table: [AppLanguage: [LocKey: String]] = [
        .en: [
            .tagline:                "Bind your own paper into a personal ebook library",

            .pickPDF:                "Choose PDF…",
            .saveEpub:               "Save as EPUB…",
            .revealInFinder:         "Show in Finder",
            .dropHint:               "or drop a PDF onto the window",

            .openPanelMessage:       "Choose a PDF to digitize (a file you own or have the right to digitize)",
            .savePanelMessage:       "Choose where to save the EPUB",

            .statusStart:            "Choose a PDF to begin",
            .statusRecognizing:      "Recognizing…",
            .statusOCRDone:          "Done — ready to save as EPUB",
            .statusAssembling:       "Assembling EPUB…",
            .statusSavedPrefix:      "Saved: ",
            .statusDropPDF:          "Please drop a PDF file",
            .statusErrorPrefix:      "Error: ",

            .fieldTitleLabel:        "Title",
            .fieldTitlePlaceholder:  "Defaults to the file name",
            .fieldAuthorLabel:       "Author / source (optional)",
            .fieldAuthorPlaceholder: "Leave blank if unknown",

            .summaryTotalPages:      "%d pages",
            .summaryTextPages:       "text %d",
            .summaryImagePages:      "image %d",
            .summaryChars:           "%d chars recognized",

            .progressOCRPage:        "OCR page %d/%d…",
            .stageWritingCover:      "Writing cover and image pages…",
            .stageWritingChapters:   "Writing %d chapters…",
            .stageValidatingXML:     "Validating XML…",
            .stagePackaging:         "Packaging EPUB…",

            .errorCannotOpenPDF:     "Cannot open PDF: %@",
            .errorZipFailed:         "EPUB packaging failed: %@",
            .errorValidation:        "EPUB validation failed: %@",
            .errorIO:                "Failed to write file: %@",

            .languageMenuLabel:      "Language",
        ],

        .ja: [
            .tagline:                "あなた自身の紙を、個人の電子書庫へ装丁する",

            .pickPDF:                "PDF を選択…",
            .saveEpub:               "EPUB として保存…",
            .revealInFinder:         "Finder で表示",
            .dropHint:               "または PDF をウインドウにドロップ",

            .openPanelMessage:       "電子化する PDF を選択（ご自身が所有、または電子化する権利のあるファイル）",
            .savePanelMessage:       "EPUB の保存先を選択",

            .statusStart:            "PDF を選んで開始",
            .statusRecognizing:      "認識中…",
            .statusOCRDone:          "完了 — EPUB として保存できます",
            .statusAssembling:       "EPUB を組み立て中…",
            .statusSavedPrefix:      "保存しました：",
            .statusDropPDF:          "PDF ファイルをドロップしてください",
            .statusErrorPrefix:      "エラー：",

            .fieldTitleLabel:        "タイトル",
            .fieldTitlePlaceholder:  "未入力ならファイル名を使用",
            .fieldAuthorLabel:       "著者／出典（任意）",
            .fieldAuthorPlaceholder: "空欄でも可",

            .summaryTotalPages:      "全 %d ページ",
            .summaryTextPages:       "テキスト %d",
            .summaryImagePages:      "画像 %d",
            .summaryChars:           "%d 文字を認識",

            .progressOCRPage:        "OCR %d/%d ページ…",
            .stageWritingCover:      "表紙と画像ページを書き出し中…",
            .stageWritingChapters:   "%d 章を書き出し中…",
            .stageValidatingXML:     "XML を検証中…",
            .stagePackaging:         "EPUB をパッケージ中…",

            .errorCannotOpenPDF:     "PDF を開けません：%@",
            .errorZipFailed:         "EPUB のパッケージに失敗：%@",
            .errorValidation:        "EPUB の検証に失敗：%@",
            .errorIO:                "ファイルの書き込みに失敗：%@",

            .languageMenuLabel:      "言語",
        ],

        .zhTW: [
            .tagline:                "把你的紙，裝幀成私人電子書庫",

            .pickPDF:                "選擇 PDF…",
            .saveEpub:               "存成 EPUB…",
            .revealInFinder:         "在 Finder 顯示",
            .dropHint:               "或將 PDF 拖放到視窗",

            .openPanelMessage:       "選擇要數位化的 PDF（你擁有或有權數位化的檔案）",
            .savePanelMessage:       "選擇 EPUB 儲存位置",

            .statusStart:            "選一個 PDF 開始",
            .statusRecognizing:      "辨識中…",
            .statusOCRDone:          "辨識完成 — 可存成 EPUB",
            .statusAssembling:       "組裝 EPUB 中…",
            .statusSavedPrefix:      "已儲存：",
            .statusDropPDF:          "請拖入 PDF 檔案",
            .statusErrorPrefix:      "錯誤：",

            .fieldTitleLabel:        "書名／標題",
            .fieldTitlePlaceholder:  "預設使用檔名",
            .fieldAuthorLabel:       "作者／來源（選填）",
            .fieldAuthorPlaceholder: "可留空",

            .summaryTotalPages:      "共 %d 頁",
            .summaryTextPages:       "文字頁 %d",
            .summaryImagePages:      "圖片頁 %d",
            .summaryChars:           "辨識 %d 字",

            .progressOCRPage:        "OCR 第 %d/%d 頁…",
            .stageWritingCover:      "寫入封面與圖片頁…",
            .stageWritingChapters:   "寫入 %d 個章節…",
            .stageValidatingXML:     "驗證 XML…",
            .stagePackaging:         "打包 EPUB…",

            .errorCannotOpenPDF:     "無法開啟 PDF：%@",
            .errorZipFailed:         "EPUB 打包失敗：%@",
            .errorValidation:        "EPUB 驗證失敗：%@",
            .errorIO:                "檔案寫入失敗：%@",

            .languageMenuLabel:      "語言",
        ],
    ]
}
