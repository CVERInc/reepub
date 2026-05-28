const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateEpub } = require('./validator');

const TEST_DIR = path.resolve(__dirname, '..', 'temp-test-validation');

// Helper to reset/create test dir
function setupTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// Helper to write valid base files into a target directory
function createValidStructure(dir) {
  fs.mkdirSync(path.join(dir, 'META-INF'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'OEBPS'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'mimetype'), 'application/epub+zip', 'utf8');

  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  fs.writeFileSync(path.join(dir, 'META-INF', 'container.xml'), containerXml, 'utf8');

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="BookID">urn:uuid:test-12345</dc:identifier>
    <meta property="dcterms:modified">2026-05-27T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="index" href="index.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="index"/>
  </spine>
</package>`;
  fs.writeFileSync(path.join(dir, 'OEBPS', 'content.opf'), contentOpf, 'utf8');

  const styleCss = `body { font-family: sans-serif; }`;
  fs.writeFileSync(path.join(dir, 'OEBPS', 'style.css'), styleCss, 'utf8');

  const indexXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Test Page</title>
  <link rel="stylesheet" href="style.css" type="text/css" />
</head>
<body>
  <h1>Hello World</h1>
  <p>This is a valid XHTML file with correct entities &amp; tag matching.</p>
</body>
</html>`;
  fs.writeFileSync(path.join(dir, 'OEBPS', 'index.xhtml'), indexXhtml, 'utf8');

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:test-12345"/>
  </head>
  <docTitle><text>Test Book</text></docTitle>
  <navMap>
    <navPoint id="nav-index" playOrder="1">
      <navLabel><text>Home</text></navLabel>
      <content src="index.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`;
  fs.writeFileSync(path.join(dir, 'OEBPS', 'toc.ncx'), tocNcx, 'utf8');
}

// Test runner
function runTests() {
  console.log('Starting validator unit tests...\n');
  let failures = 0;

  function assert(condition, message) {
    if (!condition) {
      console.error(`  [FAIL] ${message}`);
      failures++;
    } else {
      console.log(`  [PASS] ${message}`);
    }
  }

  // Test 1: Valid directory validation
  setupTestDir();
  const validDir = path.join(TEST_DIR, 'valid-dir');
  fs.mkdirSync(validDir);
  createValidStructure(validDir);
  let res = validateEpub(validDir);
  assert(res.success === true, 'Valid directory structure should pass validation');

  // Test 2: Valid zipped EPUB file validation
  const epubPath = path.join(TEST_DIR, 'valid.epub');
  execFileSync('zip', ['-0Xq', epubPath, 'mimetype'], { cwd: validDir });
  execFileSync('zip', ['-ur9q', epubPath, 'META-INF', 'OEBPS'], { cwd: validDir });
  res = validateEpub(epubPath);
  assert(res.success === true, 'Valid zipped EPUB file should pass validation');

  // Test 3: XHTML format error (strict check)
  setupTestDir();
  const invalidDirXhtml = path.join(TEST_DIR, 'invalid-dir-xhtml');
  fs.mkdirSync(invalidDirXhtml);
  createValidStructure(invalidDirXhtml);
  // Write bad XHTML (unclosed paragraph tag, unescaped '&')
  const badXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Bad Page</title></head>
<body>
  <p>Unclosed tag and unescaped ampersand & here
</body>
</html>`;
  fs.writeFileSync(path.join(invalidDirXhtml, 'OEBPS', 'index.xhtml'), badXhtml, 'utf8');
  res = validateEpub(invalidDirXhtml);
  assert(res.success === false, 'Strict XHTML check should fail for unclosed tag / unescaped &');
  assert(res.error && res.error.includes('well-formedness check failed'), 'Error output should describe XML well-formedness failure');

  // Test 4: Manifest reference missing file
  setupTestDir();
  const invalidDirMissingFile = path.join(TEST_DIR, 'invalid-dir-missing');
  fs.mkdirSync(invalidDirMissingFile);
  createValidStructure(invalidDirMissingFile);
  // Delete a file declared in manifest
  fs.unlinkSync(path.join(invalidDirMissingFile, 'OEBPS', 'style.css'));
  res = validateEpub(invalidDirMissingFile);
  assert(res.success === false, 'Validation should fail when a manifest file is missing from filesystem');
  assert(res.error && res.error.includes('references file "style.css" which does not exist'), 'Error should describe missing file reference');

  // Test 5: Orphan file in EPUB
  setupTestDir();
  const invalidDirOrphan = path.join(TEST_DIR, 'invalid-dir-orphan');
  fs.mkdirSync(invalidDirOrphan);
  createValidStructure(invalidDirOrphan);
  // Add a file not declared in manifest
  fs.writeFileSync(path.join(invalidDirOrphan, 'OEBPS', 'orphan.txt'), 'i am an orphan', 'utf8');
  res = validateEpub(invalidDirOrphan);
  assert(res.success === false, 'Validation should fail when an orphan file is found in directory');
  assert(res.error && res.error.includes('Orphan file found in EPUB'), 'Error should describe orphan file');

  // Test 6: Mimetype compression check
  setupTestDir();
  const invalidZipMimetype = path.join(TEST_DIR, 'invalid-mimetype.epub');
  // Write a mock ZIP header where the first file is 'mimetype' but compressed with method 8 (Deflated)
  const mockZipBuf = Buffer.alloc(38);
  mockZipBuf.writeUInt32LE(0x04034b50, 0); // PK\x03\x04 signature
  mockZipBuf.writeUInt16LE(8, 8); // Compression method = 8 (Deflated)
  mockZipBuf.writeUInt16LE(8, 26); // Filename length = 8
  mockZipBuf.writeUInt16LE(0, 28); // Extra field length = 0
  mockZipBuf.write('mimetype', 30, 8, 'utf8');
  fs.writeFileSync(invalidZipMimetype, mockZipBuf);

  res = validateEpub(invalidZipMimetype);
  assert(res.success === false, 'Validation should fail if mimetype is compressed');
  assert(res.error && res.error.includes('"mimetype" file must be uncompressed'), 'Error should describe mimetype compression check');

  cleanup();

  if (failures === 0) {
    console.log('\n[SUCCESS] All unit tests passed!');
    process.exit(0);
  } else {
    console.error(`\n[FAILURE] ${failures} unit test(s) failed.`);
    process.exit(1);
  }
}

runTests();
