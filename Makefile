all: build

# Native SwiftUI app (the primary product) — Command Line Tools only, no Xcode.
app:
	bash macos/build-app.sh

# Swift OCR CLI (bin/scan-ocr) — used by the Node web UI / CLI path.
build:
	mkdir -p bin
	swiftc -O src/main.swift -o bin/scan-ocr -sdk $$(xcrun --show-sdk-path)

clean:
	rm -rf bin/scan-ocr macos/build

.PHONY: all app build clean
