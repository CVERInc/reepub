const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Helper to recursively find all files in a directory
 */
function getFilesRecursively(dir, baseDir = dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFilesRecursively(fullPath, baseDir));
    } else {
      results.push(path.relative(baseDir, fullPath));
    }
  });
  return results;
}

/**
 * Parser for XML element attributes
 */
function parseAttributes(elementString) {
  const attrs = {};
  const regex = /(\w+(?:-\w+)*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = regex.exec(elementString)) !== null) {
    attrs[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  return attrs;
}

/**
 * Validates the mimetype zip layout of an EPUB file (first file, uncompressed)
 */
function validateZipMimetype(epubPath) {
  const fd = fs.openSync(epubPath, 'r');
  const buf = Buffer.alloc(38);
  try {
    fs.readSync(fd, buf, 0, 38, 0);
  } finally {
    fs.closeSync(fd);
  }

  // Signature PK\x03\x04 (0x04034b50 in little endian)
  if (buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Not a valid ZIP file (invalid local file header signature)');
  }
  
  // Compression method (offset 8, 2 bytes) must be 0 (Stored)
  const compMethod = buf.readUInt16LE(8);
  if (compMethod !== 0) {
    throw new Error('EPUB validation error: "mimetype" file must be uncompressed (compression method must be Stored/0)');
  }
  
  // Filename length (offset 26, 2 bytes) must be 8
  const filenameLen = buf.readUInt16LE(26);
  if (filenameLen !== 8) {
    throw new Error('EPUB validation error: "mimetype" must be the first file in the ZIP archive');
  }
  
  // Filename (offset 30, 8 bytes) must be 'mimetype'
  const filename = buf.toString('utf8', 30, 38);
  if (filename !== 'mimetype') {
    throw new Error(`EPUB validation error: "mimetype" must be the first file in the ZIP archive (found "${filename}")`);
  }
}

/**
 * Main validation logic on extracted directory
 */
function validateDirectory(epubDir) {
  // 1. mimetype file content check
  const mimetypePath = path.join(epubDir, 'mimetype');
  if (!fs.existsSync(mimetypePath)) {
    throw new Error('EPUB validation error: "mimetype" file is missing from root');
  }
  const mimetypeContent = fs.readFileSync(mimetypePath, 'utf8').trim();
  if (mimetypeContent !== 'application/epub+zip') {
    throw new Error(`EPUB validation error: "mimetype" file content must be exactly "application/epub+zip", found "${mimetypeContent}"`);
  }

  // 2. container.xml check
  const containerPath = path.join(epubDir, 'META-INF', 'container.xml');
  if (!fs.existsSync(containerPath)) {
    throw new Error('EPUB validation error: "META-INF/container.xml" is missing');
  }
  
  try {
    execFileSync('xmllint', ['--noout', containerPath], { stdio: 'pipe' });
  } catch (err) {
    const errMsg = err.stderr ? err.stderr.toString() : err.message;
    throw new Error(`EPUB validation error: META-INF/container.xml is not well-formed XML:\n${errMsg}`);
  }

  const containerContent = fs.readFileSync(containerPath, 'utf8');
  const rootfileMatch = containerContent.match(/<rootfile\s+[^>]*full-path=["']([^"']+)["']/);
  if (!rootfileMatch) {
    throw new Error('EPUB validation error: META-INF/container.xml does not declare a rootfile with full-path attribute');
  }
  const opfPathRelative = rootfileMatch[1];

  // 3. OPF check
  const opfPath = path.join(epubDir, opfPathRelative);
  if (!fs.existsSync(opfPath)) {
    throw new Error(`EPUB validation error: OPF rootfile "${opfPathRelative}" declared in container.xml does not exist`);
  }

  try {
    execFileSync('xmllint', ['--noout', opfPath], { stdio: 'pipe' });
  } catch (err) {
    const errMsg = err.stderr ? err.stderr.toString() : err.message;
    throw new Error(`EPUB validation error: OPF file "${opfPathRelative}" is not well-formed XML:\n${errMsg}`);
  }

  const opfContent = fs.readFileSync(opfPath, 'utf8');
  
  // Parse manifest
  const manifestMatch = opfContent.match(/<manifest>([\s\S]*?)<\/manifest>/);
  if (!manifestMatch) {
    throw new Error(`EPUB validation error: OPF file "${opfPathRelative}" is missing a <manifest> element`);
  }
  const manifestContent = manifestMatch[1];
  const itemRegex = /<item\s+([^>]+)\/?>/g;
  let match;
  const manifestItems = {};
  
  while ((match = itemRegex.exec(manifestContent)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (!attrs.id || !attrs.href) {
      throw new Error(`EPUB validation error: Manifest <item> is missing id or href attribute: ${match[0]}`);
    }
    manifestItems[attrs.id] = {
      id: attrs.id,
      href: attrs.href,
      mediaType: attrs['media-type']
    };
  }

  // Parse spine
  const spineMatch = opfContent.match(/<spine([^>]*)>([\s\S]*?)<\/spine>/);
  if (!spineMatch) {
    throw new Error(`EPUB validation error: OPF file "${opfPathRelative}" is missing a <spine> element`);
  }
  const spineContent = spineMatch[2];
  const itemrefRegex = /<itemref\s+([^>]+)\/?>/g;
  const spineRefs = [];
  
  while ((match = itemrefRegex.exec(spineContent)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (!attrs.idref) {
      throw new Error(`EPUB validation error: Spine <itemref> is missing idref attribute: ${match[0]}`);
    }
    spineRefs.push(attrs.idref);
  }

  // 4. Validate spine item references
  for (const idref of spineRefs) {
    if (!manifestItems[idref]) {
      throw new Error(`EPUB validation error: Spine refers to item idref "${idref}" which is not declared in the manifest`);
    }
  }

  // 5. Validate manifest file existence and strict XML/XHTML formatting
  const opfDir = path.dirname(opfPath);
  const manifestPaths = new Set();

  for (const id in manifestItems) {
    const item = manifestItems[id];
    const decodedHref = decodeURIComponent(item.href);
    const fileAbsPath = path.resolve(opfDir, decodedHref);

    if (!fs.existsSync(fileAbsPath)) {
      throw new Error(`EPUB validation error: Manifest item "${item.id}" references file "${decodedHref}" which does not exist`);
    }

    // Save relative path from EPUB root for orphan detection
    const fileRelToRoot = path.relative(epubDir, fileAbsPath);
    manifestPaths.add(path.normalize(fileRelToRoot));

    // XHTML/XML well-formedness validation
    const mediaType = item.mediaType || '';
    const ext = path.extname(fileAbsPath).toLowerCase();
    const isXml = mediaType === 'application/xhtml+xml' || 
                  mediaType === 'application/x-dtbncx+xml' || 
                  mediaType.endsWith('+xml') || 
                  ext === '.xhtml' || 
                  ext === '.xml' || 
                  ext === '.ncx';
    
    if (isXml) {
      try {
        execFileSync('xmllint', ['--noout', fileAbsPath], { stdio: 'pipe' });
      } catch (err) {
        const errMsg = err.stderr ? err.stderr.toString() : err.message;
        throw new Error(`EPUB validation error: XML well-formedness check failed for "${decodedHref}":\n${errMsg.trim()}`);
      }
    }
  }

  // 6. Orphan File Detection (all files in directory must be in manifest or exempted)
  const allFiles = getFilesRecursively(epubDir);
  for (const fileRelPath of allFiles) {
    const normalizedPath = path.normalize(fileRelPath);
    
    // Exempt files that aren't declared in manifest
    if (normalizedPath === 'mimetype') continue;
    if (normalizedPath === path.normalize(opfPathRelative)) continue;
    if (normalizedPath.startsWith('META-INF' + path.sep)) continue;
    if (path.basename(normalizedPath) === '.DS_Store') continue;

    if (!manifestPaths.has(normalizedPath)) {
      throw new Error(`EPUB validation error: Orphan file found in EPUB: "${fileRelPath}" is not declared in the OPF manifest`);
    }
  }
}

/**
 * Validates an EPUB file (or unpacked directory)
 * @param {string} targetPath Absolute path to .epub file or folder
 * @returns {{success: boolean, error?: string}}
 */
function validateEpub(targetPath) {
  const absolutePath = path.resolve(targetPath);
  if (!fs.existsSync(absolutePath)) {
    return { success: false, error: `Path does not exist: ${absolutePath}` };
  }

  const stat = fs.statSync(absolutePath);
  
  if (stat.isDirectory()) {
    try {
      validateDirectory(absolutePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  } else {
    // It's a file, validate mimetype first, then extract and validate directory
    try {
      validateZipMimetype(absolutePath);
    } catch (err) {
      return { success: false, error: err.message };
    }

    const tempValDir = path.join(path.dirname(absolutePath), `temp-epub-val-${Date.now()}`);
    fs.mkdirSync(tempValDir, { recursive: true });

    try {
      execFileSync('unzip', ['-q', absolutePath, '-d', tempValDir]);
      validateDirectory(tempValDir);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      if (fs.existsSync(tempValDir)) {
        fs.rmSync(tempValDir, { recursive: true, force: true });
      }
    }
  }
}

// Support CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node src/validator.js <path-to-epub-file-or-dir>');
    process.exit(1);
  }
  
  console.log(`Validating EPUB at: ${args[0]}`);
  const result = validateEpub(args[0]);
  if (result.success) {
    console.log('\n[Success] EPUB validation passed! No XML errors or Manifest omissions found.');
    process.exit(0);
  } else {
    console.error(`\n[Failure] EPUB validation failed:\n${result.error}`);
    process.exit(1);
  }
}

module.exports = {
  validateEpub
};
