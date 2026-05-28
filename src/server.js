const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 30232;
const PUBLIC_DIR = path.join(__dirname, 'public');

console.log('Starting local web server setup...');

// Ensure public directory exists
if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  
  // 1. Route: GET / - Serve index.html
  if (pathname === '/' && req.method === 'GET') {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexPath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Frontend UI (index.html) not found. Please create it.');
    }
  }
  
  // 2. Route: POST /upload - Receive raw PDF file
  else if (pathname === '/upload' && req.method === 'POST') {
    const tempPdfName = `upload-${Date.now()}.pdf`;
    const tempPdfPath = path.join(__dirname, tempPdfName);
    const fileStream = fs.createWriteStream(tempPdfPath);
    
    req.pipe(fileStream);
    
    fileStream.on('finish', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tempPath: tempPdfPath }));
    });
    
    fileStream.on('error', (err) => {
      console.error('File stream error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
  }
  
  // 3. Route: GET /convert - Stream progress of builder.js run
  else if (pathname === '/convert' && req.method === 'GET') {
    const tempPath = parsedUrl.searchParams.get('tempPath');
    const title = parsedUrl.searchParams.get('title') || 'Book';
    const author = parsedUrl.searchParams.get('author') || '';
    
    if (!tempPath || !fs.existsSync(tempPath)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Error: Missing or invalid upload file path.');
      return;
    }
    
    // Set up chunked response for streaming logs in real-time
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    
    const epubFileName = `book-${Date.now()}.epub`;
    const binDir = path.join(__dirname, '../bin');
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }
    const tempEpubPath = path.join(binDir, epubFileName);
    
    res.write(`[System] Initializing conversion for "${title}" by ${author}...\n`);
    
    // Spawn builder.js
    const builderProcess = spawn('node', [
      path.join(__dirname, 'builder.js'),
      tempPath,
      tempEpubPath,
      title,
      author
    ]);
    
    builderProcess.stdout.on('data', (chunk) => {
      res.write(chunk);
    });
    
    builderProcess.stderr.on('data', (chunk) => {
      res.write(chunk);
    });
    
    builderProcess.on('close', (code) => {
      if (code === 0) {
        res.write(`\n[System] EPUB packaging complete.\nDOWNLOAD_TOKEN:${epubFileName}\n`);
      } else {
        res.write(`\n[System] Conversion failed with exit code ${code}\n`);
      }
      res.end();
      
      // Clean up the temporary uploaded PDF
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    });
    
    builderProcess.on('error', (err) => {
      res.write(`\n[System] Error starting builder process: ${err.message}\n`);
      res.end();
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    });
  }
  
  // 4. Route: GET /download - Download compiled EPUB
  else if (pathname === '/download' && req.method === 'GET') {
    const token = parsedUrl.searchParams.get('token');
    const title = parsedUrl.searchParams.get('title') || 'book';
    
    if (!token) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing token parameter.');
      return;
    }
    
    // Safety check: prevent directory traversal
    const safeToken = path.basename(token);
    const epubFilePath = path.join(__dirname, '../bin', safeToken);
    
    if (fs.existsSync(epubFilePath)) {
      const safeFallback = title.replace(/[^\x20-\x7E]/g, '_').replace(/\s+/g, '_');
      const encodedTitle = encodeURIComponent(title);
      res.writeHead(200, {
        'Content-Type': 'application/epub+zip',
        'Content-Disposition': `attachment; filename="${safeFallback || 'book'}.epub"; filename*=UTF-8''${encodedTitle}.epub`
      });
      
      const fileStream = fs.createReadStream(epubFilePath);
      fileStream.pipe(res);
      
      // Clean up the EPUB file 5 seconds after serving is finished
      res.on('finish', () => {
        setTimeout(() => {
          if (fs.existsSync(epubFilePath)) {
            fs.unlinkSync(epubFilePath);
            console.log(`Deleted temp EPUB: ${safeToken}`);
          }
        }, 5000);
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Error: EPUB file expired or not found.');
    }
  }
  
  // 5. Fallback - 404
  else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`Reepub Web Server is running!`);
  console.log(`Open http://localhost:${PORT} in your web browser`);
  console.log(`==================================================\n`);
});
