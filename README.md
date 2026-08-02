# reepub

> Bind the paper you already own — notes, letters, manuscripts, public-domain works — into a personal library of clean, reflowable ebooks. Natively on your Mac, 100% offline.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform: macOS](https://img.shields.io/badge/Platform-macOS%2013%2B-black?logo=apple)](https://www.apple.com/macos/)
[![OCR: Apple Vision](https://img.shields.io/badge/OCR-Apple%20Vision-blue)](https://developer.apple.com/documentation/vision)
[![EPUB: 3.0](https://img.shields.io/badge/EPUB-3.0-green)](https://www.w3.org/publishing/epub3/)

**No API keys · No subscriptions · No internet · Your files never leave your machine.**

> What reepub is for. reepub is a tool for digitizing documents you own or have the right to digitize — your own writing, notes and correspondence, public-domain works, or books you physically own — into a personal ebook library you keep locally. Everything is processed on your own Mac; nothing is ever uploaded. Please respect copyright and the rights of authors and publishers.

🌐 [日本語](https://cver.net/ja-jp/oss/reepub) · [한국어](https://cver.net/ko-kr/oss/reepub) · [繁體中文](https://cver.net/zh-tw/oss/reepub)

---

## Why reepub?

You've got paper worth keeping — your own notes, a stack of letters, an
out-of-print book you own. Most "PDF to EPUB" tools either upload it to a cloud
service, charge per page, or spit out a fixed-layout EPUB that's really just
images glued together — unreadable on a phone. `reepub` is different — and the
difference is ownership:

- **You own it — you don't rent it.** Cloud OCR is a borrowed library card:
  revocable, priced per page, and your files pass through someone else's servers.
  `reepub` is the book on your own shelf — free, offline, and *yours*; no one can
  reprice it, gate it, or switch it off.
- **OCR you already paid for.** It unlocks Apple's
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
  structural validator before it's handed back; one that fails is deleted and the
  command exits non-zero. `npm test` goes further and holds a freshly built book
  to the official [epubcheck](https://github.com/w3c/epubcheck) at
  **0 errors / 0 warnings**.
- **Repairs the books you already have** — `reepub heal` fixes a broken EPUB and
  tells you exactly what it changed. Vertical right-to-left CJK volumes carrying
  four epubcheck errors each came out at zero, with every chapter and their
  reading direction intact. See [Healing](#healing-broken-books).
- **MIT-licensed**, self-contained, forkable, free forever.

## Features

- **Smart paragraph stitching** — uses line bounding boxes, vertical gaps, indents,
  and punctuation cues to merge OCR lines back into clean paragraphs.
- **Automatic cover** — renders page 1 at 2× and wraps it as the EPUB cover.
- **Hybrid text + image pages** — pages with little text (illustrations, plates)
  are preserved as images instead of garbled OCR.
- **Automatic chapter detection** — splits on heading cues (e.g. `第一章`, `Chapter`).
- **Three ways to use it** — a one-click Mac app, a local web UI, or a CLI.

- Localized app UI — English / 繁體中文 / 日本語

## Prerequisites

- **macOS** 13+ (Apple Silicon strongly recommended) for the native app
- **Xcode Command Line Tools** — for the Swift compiler (`xcode-select --install`).
  No full Xcode required.
- **Node.js** v20+ — *only* for the optional web UI / CLI path
- `zip` / `unzip` / `xmllint` — preinstalled on macOS

## Build

```bash
git clone https://github.com/CVERInc/reepub.git
cd reepub
make app            # builds macos/build/Reepub.app (Command Line Tools only)
```

## Usage

**Option A — Native macOS app (recommended)**

```bash
make app
open macos/build/Reepub.app
```

Pick a PDF (or drag one onto the window), let Vision OCR run, optionally set a
title and author, then **Save as EPUB…** to save the finished book. Everything —
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

## How it works

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
   `container.xml`, the OPF manifest/spine, XHTML well-formedness, that every
   content document actually has a `<body>`, that no internal reference dangles,
   and that nothing escapes the container. A book that fails is deleted and the
   command exits non-zero.

Every package document, table of contents and navigation document comes from
`src/binder.js` — the single place allowed to emit one. See
[PRINCIPLES.md](PRINCIPLES.md) for why that boundary exists and what CI does to
keep it.

## Healing broken books

Ebooks in the wild are broken in ways their owners never see: a forgiving reader
shows the book anyway, so the damage only surfaces when something strict refuses
it. The hardest case is a vertical, right-to-left CJK volume: the reading
direction it needs is an EPUB 3 attribute, so a book packaged as EPUB 2 has to
choose between validating and opening the right way round. `heal` gives it both.

```bash
node src/heal.js broken.epub healed.epub
```

```
Healing broken.epub → healed.epub
  西遊記 — 55 documents
  healed: EPUB 2.0 spine carried page-progression-direction → rebuilt as EPUB 3.0
  healed: table of contents identifier disagreed with the package → unified
  healed: 55 chapters declared the XHTML 1.1 doctype → <!DOCTYPE html>
  healed: dropped @font-face "DroidFont", serif, sans-serif → res:///system/fonts/DroidSansFallback.ttf cannot load in an EPUB
  ✓ healed.epub (1641 KB)
  ✓ EPUB valid
```

Healing never edits in place, and a repair that fails validation is deleted
rather than handed back. `reepub merge` performs the same repairs on the volumes
it combines — it is the same engine, so the two cannot drift apart.

What gets repaired:

- **EPUB 2 packages using an EPUB 3 spine attribute** — the merged book is EPUB 3,
  where `page-progression-direction` is legal, so vertical right-to-left series
  keep their reading direction *and* validate.
- **A table of contents whose identifier disagrees with the package** — one
  identifier is minted for the merged book and used in both.
- **Chapters still declaring the XHTML 1.1 doctype** — brought forward to
  `<!DOCTYPE html>`, with the entities that doctype used to define (`&nbsp;`,
  `&mdash;`) rewritten as numeric references so nothing stops parsing.
- **Stylesheets pointing at fonts that do not exist** — an `@font-face` whose only
  source is `res:///system/fonts/DroidSansFallback.ttf` cannot load anywhere
  except the Android reader that wrote it, and epubcheck rejects it outright.

Repair is never silent, and never a guess — an entity or reference reepub cannot
resolve stops the run rather than being mangled into something that merely looks
right.

## Validation & tests

```bash
npm test                          # unit, spec and conformance suites
npm run validate <file.epub>      # validate any EPUB (or unpacked dir)
npm run epubcheck                 # fetch the official epubcheck jar (cached)
```

`npm test` builds a real book and runs the official epubcheck against it. The
jar is fetched once into `~/.cache/reepub/` and reused; CI does the same, so the
local command and the pipeline check exactly the same thing.

## License

MIT — see [LICENSE](LICENSE). © 2026 CVER Inc.
