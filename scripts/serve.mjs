import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const allowedDirs = new Set(['', 'icons']);

const server = http.createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/') pathname = '/index.html';
    const relative = path.posix.normalize(pathname).replace(/^\/+/, '');
    const dir = path.posix.dirname(relative);
    const type = types[path.extname(relative)];
    if (!type || relative.includes('..') || !allowedDirs.has(dir === '.' ? '' : dir) || relative.startsWith('.')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const body = await readFile(path.join(root, relative));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(4173, '127.0.0.1', () => console.log('The Completion Job: http://127.0.0.1:4173'));
