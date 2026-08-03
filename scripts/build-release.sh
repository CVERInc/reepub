#!/bin/bash
# Build the CLI binaries that go into a GitHub release, as universal binaries.
#
# Why this exists rather than `make build`: `make build` produces whatever the
# host is, which is fine for developing and wrong for shipping. A release asset
# downloaded by a stranger has to run on their Mac, and macOS 13 — the floor the
# README states — still runs on Intel. Shipping an arm64-only binary under a
# name that promises macOS 13 would be a download that fails for a reason the
# person cannot see.
#
# Why lipo rather than SwiftPM's `--arch arm64 --arch x86_64`: that path needs
# xcbuild, which only ships with Xcode, and this project builds with Command
# Line Tools alone (stated twice in the Makefile and once in the README). Making
# the release path need Xcode would quietly raise the bar for anyone who wanted
# to reproduce a release. Cross-compiling each slice with `-target` and joining
# them with lipo needs nothing Xcode has.
#
# No signing and no notarization happen here — there is no Developer ID yet
# (2026-08-04). These are unsigned CLI binaries, which is an ordinary thing to
# ship and an ordinary thing for Gatekeeper to quarantine on first run; the
# release notes say how to clear it. The .app is deliberately NOT built here:
# an unsigned .app is not quarantined-with-an-escape-hatch, it is blocked, and
# shipping one would make a worse first impression than shipping nothing.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
OUT="$ROOT/dist"
DEPLOYMENT_TARGET="13.0"

# package-path : product name
PRODUCTS=("packages/scan-ocr:scan-ocr" "packages/epub-kit:epub-kit")
ARCHES=("arm64" "x86_64")

rm -rf "$OUT"
mkdir -p "$OUT/slices"

for entry in "${PRODUCTS[@]}"; do
  pkg="${entry%%:*}"
  product="${entry##*:}"

  for arch in "${ARCHES[@]}"; do
    echo "→ Building $product ($arch)"
    swift build -c release \
      --package-path "$ROOT/$pkg" \
      --product "$product" \
      -Xswiftc -target -Xswiftc "${arch}-apple-macosx${DEPLOYMENT_TARGET}"
    # SwiftPM writes every slice to the same path, so each one is copied out
    # before the next overwrites it.
    cp "$ROOT/$pkg/.build/release/$product" "$OUT/slices/$product.$arch"
  done

  echo "→ Joining $product"
  lipo -create -output "$OUT/$product" \
    "$OUT/slices/$product.arm64" "$OUT/slices/$product.x86_64"

  # A universal binary that is silently one slice is the failure this whole
  # script exists to prevent, so it is asserted rather than assumed.
  for arch in "${ARCHES[@]}"; do
    if ! lipo -archs "$OUT/$product" | tr ' ' '\n' | grep -qx "$arch"; then
      echo "✗ $product is missing the $arch slice — refusing to ship it" >&2
      exit 1
    fi
  done

  # The host slice is the only one that can be executed here, and an executable
  # that cannot answer for itself is not worth uploading. Both binaries exit
  # non-zero when run with no arguments — that is their contract, asserted in
  # scripts/check-ocr-contract.mjs — so the output is captured and matched
  # rather than piped: under `pipefail` a pipeline reports the binary's exit 1
  # even when grep succeeded, which would fail this check on a healthy build.
  usage="$("$OUT/$product" 2>&1 || true)"
  if [[ "$usage" != *"Usage: $product"* ]]; then
    echo "✗ $product does not print its usage — refusing to ship it" >&2
    echo "  got: $usage" >&2
    exit 1
  fi
done

rm -rf "$OUT/slices"

# Tarred rather than uploaded as bare executables: GitHub serves an asset as a
# plain download, and a Mach-O file that arrives without its executable bit is a
# tool that appears broken for a reason the person has no way to guess. tar
# carries the mode across.
VERSION="$(node -p "require('$ROOT/package.json').version")"
TARBALL="reepub-cli-$VERSION-macos-universal.tar.gz"

echo "→ Packaging $TARBALL"
( cd "$OUT" && tar czf "$TARBALL" scan-ocr epub-kit )

# The tarball is what people download, so it is what the checksums are for.
echo "→ Checksums"
( cd "$OUT" && shasum -a 256 "$TARBALL" > SHA256SUMS && cat SHA256SUMS )

# An archive nobody opened is a guess. This unpacks it somewhere else and runs
# what comes out, so "the download works" is measured rather than assumed.
echo "→ Verifying the packaged archive"
VERIFY="$(mktemp -d)"
trap 'rm -rf "$VERIFY"' EXIT
tar xzf "$OUT/$TARBALL" -C "$VERIFY"
for entry in "${PRODUCTS[@]}"; do
  product="${entry##*:}"
  if [[ ! -x "$VERIFY/$product" ]]; then
    echo "✗ $product came out of the tarball without its executable bit" >&2
    exit 1
  fi
  usage="$("$VERIFY/$product" 2>&1 || true)"
  if [[ "$usage" != *"Usage: $product"* ]]; then
    echo "✗ $product does not run when unpacked elsewhere" >&2
    exit 1
  fi
done

echo
echo "✓ $TARBALL — universal ($(lipo -archs "$OUT/scan-ocr")), unpacks and runs"
