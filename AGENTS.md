# AGENTS.md — driving reepub as an agent

You are likely an AI coding agent (Claude Code, Codex, Antigravity, …) being asked to fix,
extend, or release reepub. Read [PRINCIPLES.md](PRINCIPLES.md) before you write code — it is
not a manifesto, it is the list of things a machine will fail your build over. Human-facing
intro is in [README.md](README.md); the version history is in [CHANGELOG.md](CHANGELOG.md).

## What reepub is, in one breath

reepub turns **scanned PDFs, saved web pages, and broken EPUBs** into **reflowable EPUB 3
that passes the official epubcheck at zero errors**, entirely **offline on a Mac**. OCR is
Apple **Vision**, in Swift (`packages/scan-ocr`); assembly is **Swift** (`packages/epub-kit`,
where development happens) with a **Node** path (`src/`) still carrying `heal`, `merge`,
`web-ingest` and the local web UI. The pipeline has one junction — PDF → **OCR JSON** →
**book model** → EPUB — and `packages/manifest.json` is the ledger that says which side of
it every file is on. Optimized for **zh-Hant + en**, including vertical right-to-left CJK.

Repository visibility: **PUBLIC** (`CVERInc/reepub`), MIT, macOS-only (`"os": ["darwin"]`).

## Driving it headless (the part you'll actually use)

```bash
bash scripts/test.sh                       # THE gate — the same set CI runs. Ends with "ALL GREEN"
make build                                 # bin/scan-ocr, bin/epub-kit, and book-md (Command Line Tools, no Xcode)
make app                                   # macos/build/Reepub.app, ad-hoc signed
npm run epubcheck                          # fetch the official epubcheck jar into ~/.cache/reepub (once)
npm test                                   # unit + spec + conformance, incl. real epubcheck

# individual gates, when you want to know which one you broke
node scripts/check-packages.mjs            # every source file belongs to exactly one package
node scripts/check-packages.mjs --selftest # …and every one of those checks still fires
node scripts/check-book-format.mjs         # Node and Swift parsers agree on the book-model corpus
node scripts/check-book-format.mjs --selftest
node scripts/check-sync-markers.mjs        # the two promised cross-language rules
node scripts/check-optional-boundary.mjs   # the repair tools run with no browser installed
node scripts/check-ocr-contract.mjs        # bin/scan-ocr ↔ builder.js, driving the real binary
node scripts/check-release-readiness.mjs   # version agreement + the static PRINCIPLES clauses

# the tools themselves — each prints its own usage with no arguments
./bin/scan-ocr book.pdf > pages.json
./bin/epub-kit pages.json book.epub --title "…" --author "…"
node src/heal.js broken.epub healed.epub
node src/merge.js out.epub vol1.epub vol2.epub
node src/validator.js book.epub
node src/builder.js input.pdf out.epub "title" "author"
node scripts/make-cover.mjs --title "…" --out cover.jpeg
node scripts/build-from-web.js --src <dir> --out book.epub --title "…" --lang zh-TW
node scripts/optimize.js in.epub out.epub
```

`hooks/pre-push` execs `scripts/test.sh`; activate it with `git config core.hooksPath hooks`.
The Swift halves need macOS + Command Line Tools, so the gate is only fully honest on a Mac.

## Non-negotiable rules (break one and you ship something you shouldn't)

1. **Never write an artifact that failed validation, and never exit `0` after a validation
   failure.** This is PRINCIPLES §2, and it exists because reepub once shipped a 15-chapter
   book where every chapter was missing its `<body>`: the build printed `✓ EPUB valid` and
   epubcheck found 45 errors. In practice: no pipeline may end in `.catch(console.error)`.
2. **A promise nothing can check is marketing.** Every **Forbidden** clause in PRINCIPLES.md
   names the script that asserts it. Do not add a guarantee without an enforcer, and do not
   make a red gate green by weakening the gate — `--selftest` exists on two of them precisely
   because a check nobody has watched fail is not evidence of anything.
3. **Every new source file must be claimed in `packages/manifest.json`.** `check-packages.mjs`
   fails on an unowned file, a path claimed twice, a package that installs more than it
   declares, and a `<package` template outside an assembler. This ledger is enforced rather
   than documented for a reason: sessions with no memory of how the repo grew kept building in
   whichever direction was convenient, and Node is the convenient one.
4. **The two shared rules are promised across the language border; nothing else is.** The XML
   escape table and the pictograph range must agree between `src/epub-text.js` and
   `packages/epub-kit/Sources/EpubKit/EpubBuilder.swift`. Change one side and
   `check-sync-markers.mjs` goes red — fix the other side, never the marker. Everything else
   the two paths share is *recorded* as a difference, not enforced; do not report a recorded
   difference as a failure.
5. **Nothing in the conversion path may touch the network.** No API key, no endpoint, no
   analytics id, and no listener on anything but `127.0.0.1`. "Privacy that's structural, not
   a promise" is the product's leading claim, and it stops being true the moment a socket
   opens.
6. **Never put a conversion capability behind a paid tier, and never ship a build whose source
   isn't public under the same terms** (PRINCIPLES §1a). What may be sold is delivery —
   signing, notarization, auto-update, not needing Xcode. The free build is not a trial and
   must never be framed as one.
7. **Do not widen the pictograph strip into a book's own language.** CJK Extension B is text;
   arrows and bullets are diagram. A compatibility rule that quietly grows costs the reader
   content they cannot see is missing — worse than the defect it fixes.
8. 🔴 **You cannot publish to npm. It is a human action, from a real terminal.** The npm
   account uses **passkey (WebAuthn) 2FA**, so there is no OTP: `npm publish` from any
   non-TTY dies with `EOTP`, and `--otp` is not a workaround because no such code exists. The
   human runs `npm publish --auth-type=web` themselves. `reepub` is unscoped on npm; ask, then
   let them do it.
9. **Release assets come out of `scripts/build-release.sh` and nothing else.** It
   cross-compiles both CLIs for arm64 + x86_64, asserts both slices are present, unpacks the
   tarball somewhere else and runs what comes out. Hand-uploading a binary skips all of that
   and ships a download that fails on a Mac you don't own. Commit first, then tag (releases
   here carry a `v` prefix: `v1.1.0`), then upload.
10. **The `.app` is deliberately not a release asset.** There is no Developer ID yet: an
    unsigned CLI binary is quarantined with an escape hatch the release notes explain, but an
    unsigned `.app` is simply blocked. Shipping one makes a worse first impression than
    shipping nothing.
11. **Signet stays on `branch: "main"`.** In-house dependencies track latest by house rule;
    converting it to a version pin is a change of policy, not a build fix.
12. **`experiments/` is gitignored and never published**, along with any `*.epub`. It holds
    book content that is not ours to distribute. Do not move a file out of it to make a test
    fixture — `fixtures/book-md/` and `packages/cjk-specimen` exist for that.

## Honest scope (don't claim more than is here)

- **Assembly exists in two languages, and only one of them is where work happens.** Swift
  (`packages/epub-kit`) is the direction, decided 2026-08-02. The Node path
  (`ocr-builder-node`) is marked `freeze-pending`. PRINCIPLES §3's guard reads `.js` files
  only, so **it has never once seen the Swift assembler** — that section describes one
  language, not the project.
- **Most of `packages/` is a shape, not a move.** Only `scan-ocr`, `epub-kit`,
  `cjk-specimen` and `cover-probe` are `extracted`; the rest are `planned`, and their README
  says where the code actually is today (`src/`, `macos/`). The ledger's `target` and
  `sources` fields are *allowed* to disagree — that gap is the migration.
- **`layer` in the ledger is a record, not a gate.** Nothing enforces it. It becomes a promise
  the day the book model is a real boundary, not before.
- **`HANDOFF.md` and `POSITIONING.md` are gitignored.** PRINCIPLES §3 and
  `packages/manifest.json` point at HANDOFF.md for the reasoning behind the Swift decision; if
  you cloned this repo, you do not have that file. Do not add new references to it.
- **The local web UI is convenience, not a product surface.** Loopback only, and endpoints
  address uploads by server-issued ids so a caller-supplied path is not expressible.
- **Not on Homebrew.** No formula, no tap, anywhere in this repo.
- **Cover rendering needs a browser** (Playwright chromium). The repair tools deliberately do
  not: `check-optional-boundary.mjs` proves `heal` / `merge` / `validate` load and run with
  the rasteriser removed from module resolution, and that asking for pixels fails as
  `MISSING_OPTIONAL_PACKAGE` naming the package and the flag, rather than crashing.

## Where to look

- [PRINCIPLES.md](PRINCIPLES.md) — the contract, each clause naming its enforcer.
- [`packages/manifest.json`](packages/manifest.json) — the package ledger and the reasoning
  behind it; read the `$comment` before you propose moving anything.
- [`scripts/test.sh`](scripts/test.sh) and [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
  — the same checks, locally and on CI; they are kept identical on purpose.
- [`docs/measured-constants.md`](docs/measured-constants.md) — every threshold with the
  evidence that produced it. None are values anybody publishes.
- [`docs/kindle-silent-failures.md`](docs/kindle-silent-failures.md) — the disproof ledger for
  the two constructs that make a Kindle hide a whole book, including the tests that measured
  nothing.
- [`docs/data-not-format.md`](docs/data-not-format.md) — what a conversion must carry across
  and what it is correct to drop.
- [`docs/wkwebview-cover-parity.md`](docs/wkwebview-cover-parity.md) — whether the two cover
  renderers lay out the same.
- [`fixtures/book-md/README.md`](fixtures/book-md/README.md) — the book-format corpus both
  parsers are checked against.
