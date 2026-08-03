#!/usr/bin/env bash
# Single entry point — the SAME checks GitHub Actions runs (.github/workflows/ci.yml).
# build compiles the native Swift OCR CLI, so this only fully runs on macOS + Xcode.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules ] && { [ -f package-lock.json ] || [ -f package.json ]; }; then
  if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi
fi
echo "→ epubcheck (official validator, cached)"; npm run epubcheck
echo "→ test";  npm test --if-present
echo "→ build (Swift OCR CLI — needs Xcode)"; npm run build --if-present
# The Swift assembler's own suite. CI has always run this (ci.yml), and this file
# has always claimed to run the same checks — but it did not, so a local ALL GREEN
# said nothing about half of PRINCIPLES §7, whose emoji rule is asserted on both
# sides of the language border and can therefore break on one side alone.
echo "→ Swift EPUB builder self-test (needs Xcode)"; (cd macos && swift build && swift run ReepubSelfTest)
echo "→ scan-ocr ↔ builder.js wire contract"; node scripts/check-ocr-contract.mjs
echo "→ release readiness"; node scripts/check-release-readiness.mjs
echo "→ shared rules (promised) + recorded differences"; node scripts/check-sync-markers.mjs
echo "→ optional boundary (epub-doctor without a rasteriser)"; node scripts/check-optional-boundary.mjs
echo "→ package ledger"; node scripts/check-packages.mjs
echo "→ package ledger (selftest — every gate must still fire)"; node scripts/check-packages.mjs --selftest
echo "✅ ALL GREEN"
