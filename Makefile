all: build

# Native SwiftUI app (the primary product) — Command Line Tools only, no Xcode.
app:
	bash macos/build-app.sh

# Swift OCR CLI (bin/scan-ocr) — used by the Node web UI / CLI path.
# Built through SwiftPM rather than a lone swiftc invocation, because the
# recognition engine now lives in packages/scan-ocr and the app reads the same
# one. Command Line Tools are still enough; no Xcode required.
build:
	mkdir -p bin
	swift build -c release --package-path packages/scan-ocr --product scan-ocr
	cp packages/scan-ocr/.build/release/scan-ocr bin/scan-ocr

clean:
	rm -rf bin/scan-ocr macos/build macos/.build packages/scan-ocr/.build

.PHONY: all app build clean
