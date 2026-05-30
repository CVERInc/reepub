# reepub

> Bind the paper you already own — notes, letters, manuscripts, public-domain works — into a personal library of clean, reflowable ebooks. Natively on your Mac, 100% offline.
>
> 把你已經擁有的紙 —— 筆記、信件、手稿、公有領域藏書 —— 裝幀成一座乾淨、可重排的私人電子書庫。在你的 Mac 上原生執行，完全離線。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform: macOS](https://img.shields.io/badge/Platform-macOS%2010.15%2B-black?logo=apple)](https://www.apple.com/macos/)
[![OCR: Apple Vision](https://img.shields.io/badge/OCR-Apple%20Vision-blue)](https://developer.apple.com/documentation/vision)
[![EPUB: 3.0](https://img.shields.io/badge/EPUB-3.0-green)](https://www.w3.org/publishing/epub3/)

**No API keys · No subscriptions · No internet · Your files never leave your machine.**

> **reepub isn't a "PDF→EPUB converter" — it's a capability you _own_.** Studio-grade OCR that lives on your shelf, not in someone's cloud. Every cloud scan-to-ebook service makes you upload your books to a stranger's server, pay per page, and leaves the result in *their* account. reepub inverts all of it: **free, offline, yours.**
>
> **reepub 不是「PDF 轉 EPUB 工具」，而是一項你「擁有」的能力。** 媲美付費雲端的 OCR，放在你自己的書架上，而不是別人的雲端。每一套雲端掃描轉電子書服務，都要你把書上傳到陌生人的伺服器、按頁付費，成品還留在「他們的」帳號裡。reepub 把這一切反轉：**免費、離線、屬於你。**

> **What reepub is for.** reepub is a tool for digitizing documents **you own or have the right to digitize** — your own writing, notes and correspondence, public-domain works, or books you physically own — into a personal ebook library you keep locally. Everything is processed on your own Mac; nothing is ever uploaded. Please respect copyright and the rights of authors and publishers.

[**English**](#english) ・ [**繁體中文**](#繁體中文)

---

## English

### Why reepub?

You've got paper worth keeping — your own notes, a stack of letters, an
out-of-print book you own. Most "PDF to EPUB" tools either upload it to a cloud
service, charge per page, or spit out a fixed-layout EPUB that's really just
images glued together — unreadable on a phone. `reepub` is different — and the
difference is ownership:

- **You own it — you don't rent it.** Cloud OCR is a borrowed library card:
  revocable, priced per page, and your files pass through someone else's servers.
  `reepub` is the book on your own shelf — free, offline, and *yours*; no one can
  reprice it, gate it, or switch it off.
- **Frontier-quality OCR you already paid for.** It unlocks Apple's
  [Vision](https://developer.apple.com/documentation/vision) framework and the
  Neural Engine already in your Mac (M1–M4+) — so a tiny MIT tool matches *paid*
  cloud OCR, fully on-device.
- **Reflowable output, not image-glued fake EPUB** — text is reconstructed into
  real paragraphs and chapters, so it reflows on any screen size, not a frozen
  page image.
- **There is no pipe.** No API key, no account, no network call — your books
  *physically cannot* leave the machine. Privacy that's structural, not a promise.
- **Traditional Chinese & English** recognition out of the box (`zh-Hant` + `en-US`).
- **Validated EPUB3** — every book is run through a built-in, dependency-free
  structural validator before it's handed back; one that fails is rejected, not shipped.
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

- **macOS** 13+ (Apple Silicon strongly recommended) for the native app
- **Xcode Command Line Tools** — for the Swift compiler (`xcode-select --install`).
  No full Xcode required.
- **Node.js** v12+ — *only* for the optional web UI / CLI path
- `zip` / `unzip` / `xmllint` — preinstalled on macOS

### Build

```bash
git clone https://github.com/CVERInc/reepub.git
cd reepub
make app            # builds macos/build/Reepub.app (Command Line Tools only)
```

### Usage

**Option A — Native macOS app (recommended)**

```bash
make app
open macos/build/Reepub.app
```

Pick a PDF (or drag one onto the window), let Vision OCR run, optionally set a
title and author, then **存成 EPUB…** to save the finished book. Everything —
OCR, assembly, and validation — happens in the app, fully offline.

**Option B — Local web UI**

```bash
make build           # compiles the Swift OCR CLI (bin/scan-ocr) used by the server
npm start            # serves http://localhost:30232
```

Open the page, drop in a PDF, enter a title/author, and download the finished
EPUB once conversion completes. The conversion log streams live.

**Option C — Command line**

```bash
make build
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

> **reepub 的用途。** reepub 是用來數位化**你擁有、或有權數位化的文件**的工具 —— 你自己寫的東西、筆記與信件、公有領域作品，或你實際擁有的書 —— 把它們裝幀成留在本機的私人電子書庫。一切都在你自己的 Mac 上處理，不會上傳。請尊重著作權與作者、出版者的權利。

### 為什麼用 reepub？

你有想留下來的紙 —— 自己的筆記、一疊信件、一本你擁有的絕版書。市面上多數
「PDF 轉 EPUB」工具不是把它上傳到雲端、按頁收費，就是吐出一份其實只是圖片
拼起來的固定版面 EPUB —— 在手機上根本沒法讀。`reepub` 不一樣 —— 差別在於「擁有」：

- **你擁有它，而不是租用它。** 雲端 OCR 是一張借來的圖書證：可被收回、按頁計費，
  你的檔案還得經過別人的伺服器。`reepub` 是放在你自己書架上的那本書 —— 免費、離線、
  *屬於你*；沒人能改價、設限或把它關掉。
- **媲美付費雲端、而你早已付過費的 OCR。** 它解鎖了 Apple 的
  [Vision](https://developer.apple.com/documentation/vision) 框架，以及你 Mac
  （M1–M4+）裡本就存在的 Neural Engine —— 一個小小的 MIT 工具，就能在本機追平*付費*雲端 OCR。
- **真正可重排，而非圖片拼貼的假 EPUB** —— 文字會被重組成真正的段落與章節，
  能在任何螢幕尺寸自動重排，而不是凍結的頁面圖片。
- **沒有任何一條管線通向外面。** 沒有 API key、沒有帳號、沒有任何網路請求 ——
  你的書*在物理上就無法*離開這台機器。這是結構性的隱私，不是一句承諾。
- 內建 **繁體中文與英文** 辨識（`zh-Hant` + `en-US`）。
- **驗證過的 EPUB3** —— 每本書交回給你之前，都會經過內建、零依賴的結構驗證器檢查；
  驗證不過的書會被拒絕，不會交付。
- **MIT 授權**、自包含、可自由 fork、永遠免費。

### 特色

- **智慧段落縫合** —— 用行的 bounding box、垂直間距、縮排與標點線索，把 OCR 的
  斷行重新合併成乾淨段落。
- **自動封面** —— 將第 1 頁以 2× 算圖並包成 EPUB 封面。
- **文字 / 圖片混排頁** —— 文字極少的頁面（插圖、圖版）會保留為圖片，而非亂碼 OCR。
- **自動章節偵測** —— 依標題線索（第一章…、Chapter…）切分章節。
- **三種使用方式** —— 一鍵 Mac App、本機網頁介面，或 CLI。

### 環境需求

- **macOS** 13 以上（強烈建議 Apple Silicon）——原生 App
- **Xcode Command Line Tools** —— Swift 編譯器（`xcode-select --install`），
  不需要完整的 Xcode。
- **Node.js** v12 以上 —— *僅* 在使用網頁介面／CLI 時需要
- `zip`／`unzip`／`xmllint` —— macOS 內建

### 編譯

```bash
git clone https://github.com/CVERInc/reepub.git
cd reepub
make app            # 建立 macos/build/Reepub.app（只需 Command Line Tools）
```

### 使用方式

**方式 A —— 原生 macOS App（推薦）**

```bash
make app
open macos/build/Reepub.app
```

選擇一份 PDF（或直接拖進視窗），讓 Vision OCR 跑完，視需要填入書名與作者，再按
**存成 EPUB…** 儲存完成的書。OCR、組裝與驗證全部在 App 內完成，完全離線。

**方式 B —— 本機網頁介面**

```bash
make build           # 編譯伺服器使用的 Swift OCR CLI（bin/scan-ocr）
npm start            # 提供 http://localhost:30232
```

開啟頁面、拖入 PDF、輸入書名／作者，轉換完成後即可下載 EPUB。轉換過程的日誌會即時串流。

**方式 C —— 命令列**

```bash
make build
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
