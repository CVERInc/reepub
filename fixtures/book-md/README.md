# Book-format fixtures

One `.md` per hazard named in [`docs/data-not-format.md`](../../docs/data-not-format.md).

These exist so that the day a second implementation parses this format, there is
something to compare it against that was chosen before either parser was
written. A fixture set assembled after the fact tests what the code already
does.

`scripts/check-book-format.mjs` asserts this directory stays complete against
the ledger — a hazard added to the ledger with no fixture here is a gap the
machine finds, not the next reader.
