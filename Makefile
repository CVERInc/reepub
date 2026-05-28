all: build

build:
	mkdir -p bin
	swiftc -O src/main.swift -o bin/scan-ocr -sdk $$(xcrun --show-sdk-path)

clean:
	rm -rf bin/scan-ocr

.PHONY: all build clean
