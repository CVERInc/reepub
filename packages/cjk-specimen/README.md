# cjk-specimen

**node** · extracted · public

Specimen text for CJK typography fixtures, and the list of places CJK layout is
known to break.

Latin typesetting has lorem ipsum, whose whole job is to mean nothing so that
nobody reads it. This has a different job, and the difference is the point: a
fixture that renders beautifully and never touches a boundary proves nothing
when it passes.

## Two layers

**SOURCE** — each script's own founding text. All three are public domain, all
three are documents *about their own writing system*, and all three are what a
type foundry already prints to show a typeface.

| | text | its own constraint |
|---|---|---|
| Han | 千字文 (6C, 周興嗣) | a thousand characters, by design no two the same |
| Kana | いろは歌 | every kana exactly once |
| Hangul | 훈민정음 (1443) | the proclamation that introduced the script |

Hangul carries word spaces where Han and kana do not — a difference worth having
in a fixture, since a line-setting rule that only ever sees gapless text has
never been asked the question.

**HAZARD** — the layout failures this repository actually hit, each with what it
is for and where the evidence lives. Two examples of what that buys:

- `extensionB` (U+21489) earns its place twice. It is why pictograph stripping
  stops short of U+20000 — the character displayed perfectly on a device, so
  "the astral plane is the problem" was the wrong hypothesis — *and* it is a
  UTF-16 surrogate pair, so JS counts 2 where Swift counts 1, which is the exact
  disagreement `check-sync-markers` exists to catch.
- `strokeExtremes` (一 against 鬱) is one stroke against twenty-nine. Ink
  coverage on a greyscale thumbnail is measured in percentages, and evenly-dense
  characters can clear a threshold the real extremes would fail.

## Rare characters are built, not pasted

Extension B is absent from most fonts, so a maintainer reading the source may
see a replacement glyph — and not a neutral box, but the red diamond meaning
*invalid*, which reads as a corrupt file rather than as a rare character.

A specimen whose point is "this may not render" is useless as documentation if
the note goes down with the glyph. So the rare ones are constructed from their
codepoint:

```js
char: String.fromCodePoint(0x21489)
```

The source stays legible in any terminal, and the character is still exercised
at run time.

## Where it does not belong

Fixtures that test **rendering** should use this. Fixtures that test **a
judgement about real titles** must not: the English title-setting corpus and the
justified `lineScales` encode line breaks measured off real covers, and specimen
text has no correct answer to compare against. Swapping those would leave the
assertions green while quietly changing what they prove.

## Licence

MIT. © 2026 CVER Inc. The three source texts are public domain.
