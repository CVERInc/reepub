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
echo "→ release readiness"; node scripts/check-release-readiness.mjs
echo "→ sync markers (Node/Swift EPUB builders)"; node scripts/check-sync-markers.mjs
echo "→ package ledger"; node scripts/check-packages.mjs
echo "→ package ledger (selftest — every gate must still fire)"; node scripts/check-packages.mjs --selftest
echo "✅ ALL GREEN"
