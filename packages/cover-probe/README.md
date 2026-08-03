# cover-probe

Renders an HTML file offscreen with WKWebView and writes a PNG.

It exists to answer one question with a measurement rather than an opinion:
**does WKWebView lay out reepub's typeset cover the same way Chromium does?**
The cover is the last thing keeping Playwright and a bundled Chromium in the
dependency list, and the migration is only safe if the answer is yes.

It is an instrument, not a product. It does not fit type, measure lines or
decide anything — the cover generator does all of that in the browser, and
porting *that* loop is the actual migration. This only renders and snapshots,
which is exactly enough to compare two engines on identical input.

Findings, and how to reproduce them: [`docs/wkwebview-cover-parity.md`](../../docs/wkwebview-cover-parity.md).

```
swift run --package-path packages/cover-probe CoverProbe cover.html out.png 1600 2260
```

Note that the PNG comes out at the display's backing scale — 3200×4520 on a
Retina Mac for a 1600×2260 request. That is not a bug and it is worth knowing
before comparing anything: reading a 3200-wide buffer with 1600-wide indexing
produces a confident, entirely fictional answer.
