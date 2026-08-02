# scan-ocr

**swift** · extracted · public

A scanned PDF, recognised on your own Mac. Apple Vision + PDFKit, one JSON line
per line of text, with its bounding box. No account, no API key, no network
call — not as a policy, but because there is no code here that could make one.

It knows nothing about EPUB. That is the point: it used to be reachable only by
building a book, and recognising a PDF is a far more common thing to want.

## Use it

```bash
swift build -c release --product scan-ocr
.build/release/scan-ocr scanned.pdf > pages.json
```

Give it a second argument and page one is written there as a JPEG, with any
later page that recognises as almost no text saved beside it as a plate:

```bash
.build/release/scan-ocr scanned.pdf out/images/cover.jpeg > pages.json
```

Progress and diagnostics go to stderr, so stdout is only ever the JSON.

## What comes out

```json
[
  {
    "pageIndex": 0,
    "type": "text",
    "lines": [
      { "text": "第一章", "x": 0.41, "y": 0.88, "width": 0.17, "height": 0.03 }
    ]
  }
]
```

`x` / `y` / `width` / `height` are normalized to the page, `y` measured from the
bottom. Lines arrive top-to-bottom, then left-to-right. `type` is `"text"` or
`"image"` — a page recognising as fewer than 120 characters is an illustration
or a plate, and keeping it as a picture beats shipping garbled OCR of it.
`imagePath` appears only on pages actually written to disk.

## As a library

```swift
import ScanOCR

let pages = try OCREngine.recognize(pdfURL: url, progress: { done, total in
    print("\(done)/\(total)")
})
```

`keepImages: false` drops each page bitmap once it has been handed to `onPage`,
which is what makes a three-hundred-page scan affordable in a command line that
writes its plates as it goes. The app leaves it on, because it holds the whole
book at once.

The recognition constants — render scale, same-line tolerance, the text/image
threshold — are `public` on `OCREngine`. Each was written twice before this
package existed, once for the command line and once for the app, with a comment
claiming the two agreed and nothing checking it.

## Downstream of a router

[`pdf-inspector`](https://github.com/firecrawl/pdf-inspector) answers a question
this tool does not: *does this PDF need OCR at all?* Roughly half of PDFs carry
extractable text already, and recognising those is wasted work.

The two compose — one decides, the other does:

```bash
if pdf-inspector classify book.pdf | grep -q scanned; then
  scan-ocr book.pdf > pages.json      # nothing to extract: recognise it
else
  pdf-inspector extract book.pdf      # the text is already in there
fi
```

## Requirements

macOS 13+, Apple Silicon strongly recommended. Xcode Command Line Tools are
enough — no full Xcode.

## Licence

MIT. © 2026 CVER Inc.
