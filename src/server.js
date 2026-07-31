const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Loopback only, never 0.0.0.0: the promise is that a book physically cannot
// leave this machine, so nothing on the LAN may reach any route here.
const HOST = '127.0.0.1';
const PORT = Number(process.env.REEPUB_PORT) || 30232;
const PUBLIC_DIR = path.join(__dirname, 'public');

// A 400-page 300dpi scan is a few hundred MB; past this it is not a book
// someone dropped onto the page.
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF-');
const TOO_LARGE = `PDF exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`;
const NOT_A_PDF = 'Only PDF files are accepted (missing %PDF- header).';

// Everything a request creates lives here: mode 0700, outside the repo, and
// removed when the process exits. bin/ holds the native scan-ocr binary and is
// neither written to nor served.
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reepub-web-'));

// The only bridge from a request to a filesystem path. Clients name files with
// opaque ids this process minted, so "read or delete the path I give you" is
// not a request this server can express.
//   uploads:   uploadId      -> absolute path of the received PDF
//   artifacts: downloadToken -> { epubPath, title }
const uploads = new Map();
const artifacts = new Map();

function newId() {
  return crypto.randomUUID();
}

// Ids are single-use: claiming one removes it, so a replayed or concurrently
// raced id resolves to nothing instead of to a second delete or download.
function claim(registry, id) {
  if (typeof id !== 'string' || !registry.has(id)) {
    return null;
  }
  const entry = registry.get(id);
  registry.delete(id);
  return entry;
}

// An fs failure inside a stream or child-process event handler has no caller
// to catch it, so an unlink that throws there would take the server down with
// it. Only paths under WORK_DIR are ever passed here.
function removeQuietly(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    console.error(`Cleanup failed for ${target}: ${err.message}`);
  }
}

function sendJson(res, status, payload, onSent) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload), onSent);
}

function sendText(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

// The three spellings of "this machine, this server" — the only origins the
// UI can legitimately be loaded from.
const LOCAL_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  `http://[::1]:${PORT}`
]);

function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string') {
    return false;
  }
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

// A page the user merely visits must not be able to drive this server. Browsers
// label every request they send, so anything labelled cross-site — or carrying
// a foreign Origin — is refused; and the Host must still name loopback, so a
// domain that resolves to 127.0.0.1 (DNS rebinding) buys nothing either.
function isLocalCaller(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return false;
  }
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGINS.has(origin.toLowerCase())) {
    return false;
  }
  return isLoopbackHost(req.headers.host);
}

// RFC 6266: filename* (RFC 5987) carries the real UTF-8 title, and the quoted
// fallback exists for clients that ignore it — so quotes, backslashes, control
// characters and non-ASCII are replaced there rather than escaped. The slice
// is by code point: cutting a surrogate pair would make encodeURIComponent
// throw. attr-char excludes ' ( ) * !, which encodeURIComponent leaves bare.
function epubContentDisposition(title) {
  const trimmed = Array.from(title).slice(0, 80).join('').trim() || 'book';
  const ascii = trimmed.replace(/["\\]/g, '').replace(/[^\x20-\x7E]/g, '_').trim() || 'book';
  const encoded = encodeURIComponent(trimmed)
    .replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}.epub"; filename*=UTF-8''${encoded}.epub`;
}

// The read stream is opened before any header is written, so an unreadable
// file still produces a clean 404 instead of a truncated 200.
function streamFile(res, filePath, headers, notFoundMessage) {
  const stream = fs.createReadStream(filePath);

  stream.on('open', () => {
    res.writeHead(200, headers);
    stream.pipe(res);
  });

  stream.on('error', (err) => {
    console.error(`Failed to read ${filePath}: ${err.message}`);
    if (res.headersSent) {
      res.end();
    } else {
      sendText(res, 404, notFoundMessage);
    }
  });

  res.on('close', () => stream.destroy());
}

const server = http.createServer((req, res) => {
  // A client that walks away mid-stream must not surface as an unhandled
  // 'error' event on the response.
  res.on('error', (err) => console.error(`Response error: ${err.message}`));

  if (!isLocalCaller(req)) {
    sendText(res, 403, 'Reepub only answers requests from its own page on this machine.');
    return;
  }

  // Fixed base: only the path and query are ever read, and no Host header —
  // however malformed — can make this parse throw.
  const parsedUrl = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = parsedUrl.pathname;

  // 1. Route: GET / - Serve index.html
  if (pathname === '/' && req.method === 'GET') {
    streamFile(res, path.join(PUBLIC_DIR, 'index.html'),
      { 'Content-Type': 'text/html; charset=utf-8' },
      'Frontend UI (index.html) not found. Please create it.');
  }

  // 2. Route: POST /upload - Receive a raw PDF, answer with an opaque id
  else if (pathname === '/upload' && req.method === 'POST') {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      sendJson(res, 413, { success: false, error: TOO_LARGE }, () => req.destroy());
      return;
    }

    const uploadId = newId();
    const pdfPath = path.join(WORK_DIR, `${uploadId}.pdf`);
    const sink = fs.createWriteStream(pdfPath);
    let received = 0;
    let head = Buffer.alloc(0);
    let rejected = false;

    // A rejected upload leaves nothing behind: the sink dies, the partial file
    // goes, and the client is told why before the socket is dropped.
    const reject = (status, error) => {
      if (rejected) {
        return;
      }
      rejected = true;
      req.unpipe(sink);
      sink.destroy();
      removeQuietly(pdfPath);
      if (!res.headersSent) {
        sendJson(res, status, { success: false, error }, () => req.destroy());
      }
    };

    // The declared Content-Type is caller-supplied and proves nothing; the
    // first bytes on the wire decide whether this is a PDF.
    req.on('data', (chunk) => {
      if (rejected) {
        return;
      }
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        reject(413, TOO_LARGE);
        return;
      }
      if (head.length < PDF_MAGIC.length) {
        head = Buffer.concat([head, chunk.subarray(0, PDF_MAGIC.length - head.length)]);
        if (head.length === PDF_MAGIC.length && !head.equals(PDF_MAGIC)) {
          reject(415, NOT_A_PDF);
        }
      }
    });

    req.on('close', () => {
      if (!req.complete) {
        reject(400, 'Upload interrupted.');
      }
    });

    req.pipe(sink);

    sink.on('finish', () => {
      if (rejected) {
        return;
      }
      if (!head.equals(PDF_MAGIC)) {
        reject(415, NOT_A_PDF);
        return;
      }
      uploads.set(uploadId, pdfPath);
      sendJson(res, 200, { success: true, uploadId });
    });

    sink.on('error', (err) => {
      console.error('File stream error:', err);
      reject(500, err.message);
    });
  }

  // 3. Route: GET /convert - Stream progress of builder.js run
  else if (pathname === '/convert' && req.method === 'GET') {
    const pdfPath = claim(uploads, parsedUrl.searchParams.get('uploadId'));
    const title = (parsedUrl.searchParams.get('title') || '').trim() || 'Book';
    const author = (parsedUrl.searchParams.get('author') || '').trim();

    if (!pdfPath) {
      sendText(res, 400, 'Error: unknown or already-used uploadId.');
      return;
    }

    // Set up chunked response for streaming logs in real-time
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const token = newId();
    const epubPath = path.join(WORK_DIR, `${token}.epub`);
    let settled = false;

    // One exit for every ending — success, non-zero exit, spawn failure, or a
    // client that hung up — so the uploaded PDF is always released and the
    // response is never written to twice.
    const finishConversion = (line, keepArtifact) => {
      if (settled) {
        return;
      }
      settled = true;
      removeQuietly(pdfPath);
      if (keepArtifact) {
        artifacts.set(token, { epubPath, title });
      } else {
        removeQuietly(epubPath);
      }
      res.end(line);
    };

    res.write(`[System] Initializing conversion for "${title}" by ${author}...\n`);

    const builderProcess = spawn(process.execPath, [
      path.join(__dirname, 'builder.js'),
      pdfPath,
      epubPath,
      title,
      author
    ]);

    const forward = (chunk) => {
      if (!settled && !res.writableEnded) {
        res.write(chunk);
      }
    };

    builderProcess.stdout.on('data', forward);
    builderProcess.stderr.on('data', forward);

    builderProcess.on('close', (code) => {
      if (code === 0) {
        finishConversion(`\n[System] EPUB packaging complete.\nDOWNLOAD_TOKEN:${token}\n`, true);
      } else {
        finishConversion(`\n[System] Conversion failed with exit code ${code}\n`, false);
      }
    });

    builderProcess.on('error', (err) => {
      finishConversion(`\n[System] Error starting builder process: ${err.message}\n`, false);
    });

    res.on('close', () => {
      if (!settled) {
        builderProcess.kill();
        finishConversion('', false);
      }
    });
  }

  // 4. Route: GET /download - Download the EPUB this process minted the token for
  else if (pathname === '/download' && req.method === 'GET') {
    const artifact = claim(artifacts, parsedUrl.searchParams.get('token'));

    if (!artifact) {
      sendText(res, 404, 'Error: EPUB expired, already downloaded, or unknown token.');
      return;
    }

    // The download name comes from the registry, not from the query string —
    // no caller-supplied text ever reaches a response header.
    streamFile(res, artifact.epubPath, {
      'Content-Type': 'application/epub+zip',
      'Content-Disposition': epubContentDisposition(artifact.title)
    }, 'Error: EPUB expired or not found.');

    // Single-use: the file goes when the response does, whether it completed
    // or the client walked away.
    res.on('close', () => removeQuietly(artifact.epubPath));
  }

  // 5. Fallback - 404
  else {
    sendText(res, 404, 'Not Found');
  }
});

// Uploads are the user's books; the workspace must not outlive the process.
process.on('exit', () => removeQuietly(WORK_DIR));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

server.listen(PORT, HOST, () => {
  console.log(`\n==================================================`);
  console.log(`Reepub Web Server is running!`);
  console.log(`Open http://localhost:${PORT} in your web browser`);
  console.log(`Bound to ${HOST} only — nothing outside this Mac can reach it.`);
  console.log(`==================================================\n`);
});
