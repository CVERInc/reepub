# reepub

> Turn scanned PDFs into clean, reflowable EPUB books — natively on your Mac, 100% offline.
>
> 把掃描的 PDF 轉成乾淨、可重排的 EPUB 電子書 —— 在你的 Mac 上原生執行，完全離線。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform: macOS](https://img.shields.io/badge/Platform-macOS%2010.15%2B-black?logo=apple)](https://www.apple.com/macos/)
[![OCR: Apple Vision](https://img.shields.io/badge/OCR-Apple%20Vision-blue)](https://developer.apple.com/documentation/vision)
[![EPUB: 3.0](https://img.shields.io/badge/EPUB-3.0-green)](https://www.w3.org/publishing/epub3/)

**No API keys · No subscriptions · No internet · Your files never leave your machine.**

[**English**](#english) ・ [**繁體中文**](#繁體中文)

---

## English

### Why reepub?

Most "PDF to EPUB" tools either upload your book to a cloud service, charge per
page, or spit out a fixed-layout EPUB that's really just images glued together —
unreadable on a phone. `reepub` is different:

- **Runs entirely on your Mac** via Apple's [Vision](https://developer.apple.com/documentation/vision)
  framework. Your scanned book never leaves your machine.
- **Neural Engine accelerated** on Apple Silicon (M1–M4+) for fast, high-quality OCR.
- **Reflowable output** — text is reconstructed into real paragraphs and chapters,
  so it reflows on any screen size, not a frozen page image.
- **Traditional Chinese & English** recognition out of the box (`zh-Hant` + `en-US`).
- **Validated EPUB3** — every book is run through a built-in, dependency-free
  structural validator before it's handed back to you.
- **MIT-licensed**, self-contained, forkable, free forever.

### Features

- **Smart paragraph stitching** — uses line bounding boxes, vertical gaps, indents,
  and punctuation cues to merge OCR lines back into clean paragraphs.
- **Automatic cover** — renders page 1 at 2× and wraps it as the EPUB cover.
- **Hybrid text + image pages** — pages with little text (illustrations, plates)
  are preserved as images instead of garbled OCR.
- **Automatic chapter detection** — splits on heading cues (第一章…、Chapter…).
- **Three ways to use it** — a one-click Mac app, a local web UI, or a CLI.

### Prerequisites

- **macOS** 10.15+ (Apple Silicon strongly recommended)
- **Xcode Command Line Tools** — for the Swift compiler (`xcode-select --install`)
- **Node.js** v12+
- `zip` / `unzip` / `xmllint` — preinstalled on macOS

### Build

```bash
git clone https://github.com/CVERInc/reepub.git
cd reepub
make build          # compiles src/main.swift → bin/scan-ocr
```

Optionally build the one-click launcher app:

```bash
bash bin/build-app.sh   # creates Reepub.app
```

### Usage

**Option A — One-click app (easiest)**

Double-click **`Reepub.app`**. It starts the local server and opens the web UI in
your browser. Run it again to reopen the page or shut the server down.

**Option B — Local web UI**

```bash
npm start            # serves http://localhost:30232
```

Open the page, drop in a PDF, enter a title/author, and download the finished
EPUB once conversion completes. The conversion log streams live.

**Option C — Command line**

```bash
node src/builder.js <input.pdf> <output.epub> [book-title] [book-author]
```

Example:

```bash
node src/builder.js ~/Documents/scanned_book.pdf ~/Desktop/my_book.epub "我的書名" "作者"
```

### How it works

1. **OCR extraction** — `bin/scan-ocr` (Swift) loads the PDF via PDFKit, renders
   each page to a bitmap at 2× scale, and runs Apple's `VNRecognizeTextRequest`.
   It emits JSON of every recognized line with normalized bounding boxes, saves
   page 1 as the cover, and saves low-text pages as image plates.
2. **Text reassembly** — `src/builder.js` filters out headers/footers, stitches
   lines into paragraphs using geometry + punctuation heuristics, detects
   headings, and groups everything into chapters.
3. **EPUB packaging** — writes a standards-compliant EPUB3 (`content.opf`,
   `toc.ncx`, per-chapter XHTML, cover) and zips it with the uncompressed
   `mimetype` entry first.
4. **Validation** — `src/validator.js` checks the ZIP mimetype layout,
   `container.xml`, the OPF manifest/spine, XHTML well-formedness (via `xmllint`),
   and orphan files. A book that fails validation is rejected, not shipped.

### Validation & tests

```bash
npm test                          # run the validator unit tests
npm run validate <file.epub>      # validate any EPUB (or unpacked dir)
```

### License

MIT — see [LICENSE](LICENSE). © 2026 CVER Inc.

---

## 繁體中文

### 為什麼用 reepub？

市面上多數「PDF 轉 EPUB」工具不是把你的書上傳到雲端、按頁收費，就是吐出一份
其實只是圖片拼起來的固定版面 EPUB —— 在手機上根本沒法讀。`reepub` 不一樣：

- **完全在你的 Mac 上執行**，使用 Apple 的 [Vision](https://developer.apple.com/documentation/vision)
  框架，掃描的書檔不會離開你的電腦。
- 在 Apple Silicon（M1–M4+）上由 **Neural Engine 加速**，OCR 又快又準。
- **可重排版面** —— 文字會被重組成真正的段落與章節，能在任何螢幕尺寸自動重排，
  而不是凍結的頁面圖片。
- 內建 **繁體中文與英文** 辨識（`zh-Hant` + `en-US`）。
- **驗證過的 EPUB3** —— 每本書交回給你之前，都會經過內建、零依賴的結構驗證器檢查。
- **MIT 授權**、自包含、可自由 fork、永遠免費。

### 特色

- **智慧段落縫合** —— 用行的 bounding box、垂直間距、縮排與標點線索，把 OCR 的
  斷行重新合併成乾淨段落。
- **自動封面** —— 將第 1 頁以 2× 算圖並包成 EPUB 封面。
- **文字 / 圖片混排頁** —— 文字極少的頁面（插圖、圖版）會保留為圖片，而非亂碼 OCR。
- **自動章節偵測** —— 依標題線索（第一章…、Chapter…）切分章節。
- **三種使用方式** —— 一鍵 Mac App、本機網頁介面，或 CLI。

### 環境需求

- **macOS** 10.15 以上（強烈建議 Apple Silicon）
- **Xcode Command Line Tools** —— Swift 編譯器（`xcode-select --install`）
- **Node.js** v12 以上
- `zip`／`unzip`／`xmllint` —— macOS 內建

### 編譯

```bash
git clone https://github.com/CVERInc/reepub.git
cd reepub
make build          # 將 src/main.swift 編譯成 bin/scan-ocr
```

也可以選擇建立一鍵啟動的 App：

```bash
bash bin/build-app.sh   # 產生 Reepub.app
```

### 使用方式

**方式 A —— 一鍵 App（最簡單）**

雙擊 **`Reepub.app`**，它會啟動本機伺服器並在瀏覽器開啟網頁介面。再次執行可重新
開啟頁面或關閉伺服器。

**方式 B —— 本機網頁介面**

```bash
npm start            # 提供 http://localhost:30232
```

開啟頁面、拖入 PDF、輸入書名／作者，轉換完成後即可下載 EPUB。轉換過程的日誌會即時串流。

**方式 C —— 命令列**

```bash
node src/builder.js <input.pdf> <output.epub> [書名] [作者]
```

範例：

```bash
node src/builder.js ~/Documents/scanned_book.pdf ~/Desktop/my_book.epub "我的書名" "作者"
```

### 運作原理

1. **OCR 擷取** —— `bin/scan-ocr`（Swift）透過 PDFKit 載入 PDF，將每頁以 2× 算成
   點陣圖，再跑 Apple 的 `VNRecognizeTextRequest`。輸出每一行文字及其正規化
   bounding box 的 JSON，將第 1 頁存為封面，並把低文字頁存成圖版。
2. **文字重組** —— `src/builder.js` 濾掉頁首／頁尾，依幾何與標點啟發式把斷行縫成
   段落，偵測標題，再把全部內容歸成章節。
3. **EPUB 打包** —— 寫出符合標準的 EPUB3（`content.opf`、`toc.ncx`、各章 XHTML、
   封面），並以未壓縮的 `mimetype` 為第一個項目進行打包。
4. **驗證** —— `src/validator.js` 檢查 ZIP 的 mimetype 配置、`container.xml`、OPF
   manifest／spine、XHTML 格式正確性（透過 `xmllint`）以及孤兒檔。驗證不過的書會被
   拒絕，不會交付。

### 驗證與測試

```bash
npm test                          # 執行驗證器單元測試
npm run validate <file.epub>      # 驗證任一 EPUB（或解開的資料夾）
```

### 授權

MIT —— 詳見 [LICENSE](LICENSE)。© 2026 CVER Inc.
