#!/usr/bin/env node
// Development server for the app folder: correct MIME types and no browser caching, so a `git pull` is picked up on
// the next reload (python's http.server sends no Cache-Control and browsers then keep old modules for days).
// Usage: node scripts/serve.mjs [--port 8787] [--root <folder>] [--host 127.0.0.1]
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const root = path.resolve(opt('--root', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')));
const port = Number(opt('--port', process.env.PORT || 8787));
const host = opt('--host', undefined); // undefined = all interfaces, like python -m http.server
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.ics': 'text/calendar; charset=utf-8' };

export function serve(rootDir, p, h) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath;
      try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end('bad request'); }
      if (urlPath.endsWith('/')) urlPath += 'index.html';
      const file = path.normalize(path.join(rootDir, urlPath));
      if (file !== rootDir && !file.startsWith(rootDir + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
      let st;
      try { st = statSync(file); } catch { res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('not found: ' + urlPath); }
      if (st.isDirectory()) { res.writeHead(301, { Location: urlPath + '/' }); return res.end(); }
      const mtime = new Date(Math.floor(st.mtimeMs / 1000) * 1000);
      const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache, must-revalidate', 'Last-Modified': mtime.toUTCString() };
      const ims = req.headers['if-modified-since'];
      if (ims && new Date(ims).getTime() >= mtime.getTime()) { res.writeHead(304, headers); return res.end(); }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).pipe(res);
    });
    server.listen(p, h, () => resolve(server));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await serve(root, port, host);
  const a = server.address();
  console.log(`LNP Lab: http://localhost:${a.port}/   (serving ${root}, Ctrl+C to stop)`);
}
