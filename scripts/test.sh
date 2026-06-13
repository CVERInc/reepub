#!/usr/bin/env bash
# Single entry point — the SAME checks GitHub Actions runs (.github/workflows/ci.yml).
# build compiles the native Swift OCR CLI, so this only fully runs on macOS + Xcode.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules ] && { [ -f package-lock.json ] || [ -f package.json ]; }; then
  if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi
fi
echo "→ test";  npm test --if-present
echo "→ build (Swift OCR CLI — needs Xcode)"; npm run build --if-present
echo "→ release readiness"; node scripts/check-release-readiness.mjs
echo "✅ ALL GREEN"
