#!/usr/bin/env node
// Local development server.
//
// Serves public/ and routes /api/* through exactly the same handler the
// deployed function uses, so what works here works there.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../lib/routes.js';
import { handle } from '../lib/router.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const PORT = Number(process.env.PORT || 4000);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://internal');
  if (pathname.startsWith('/api/')) return handle(req, res);

  let file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403); return res.end();
  }
  // A directory means its own index.html if it has one — /shop/ is the
  // customer app, a separate page, not the back office's SPA route.
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    const inner = path.join(file, 'index.html');
    file = fs.existsSync(inner) ? inner : file;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(PUBLIC, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`MS BEAU AVE → http://localhost:${PORT}`));
}

export { server };
