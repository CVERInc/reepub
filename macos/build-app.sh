#!/bin/bash
# Build the native SwiftUI Reepub.app using Command Line Tools only (no Xcode).
# The macOS app is an SwiftPM package (depends on Signet), so this builds via
# `swift build` and bundles the release binary.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$DIR/.." && pwd)"
BUILD_DIR="$DIR/build"
APP="$BUILD_DIR/Reepub.app"

echo "→ Cleaning previous build"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "→ Building (SwiftPM release)"
( cd "$DIR" && swift build -c release --product ReepubApp )
# Bundle executable is named "Reepub" to match Info.plist's CFBundleExecutable.
cp "$DIR/.build/release/ReepubApp" "$APP/Contents/MacOS/Reepub"

echo "→ Assembling bundle"
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# Reuse an existing .icns if one is available (optional)
ICON_SRC="$PROJECT_DIR/Reepub.app/Contents/Resources/applet.icns"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$APP/Contents/Resources/Reepub.icns"
fi

echo "→ Ad-hoc code signing"
xattr -cr "$APP"
codesign --force --sign - "$APP"

echo "✓ Built: $APP"
