import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../public', import.meta.url));
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf' };

// Serve only public/, on this computer; never expose the repo, raw CSV, or scripts.
export function createAppServer() {
  return createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let path;
    try {
      path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400).end('Invalid URL.');
      return;
    }
    const file = resolve(root, path === '/' ? 'index.html' : path.slice(1));
    if (relative(root, file).startsWith('..') || !types[extname(file)]) {
      response.writeHead(404).end('Not found.');
      return;
    }
    try {
      const content = await readFile(file);
      response.writeHead(200, {
        'Content-Type': types[extname(file)],
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const missing = error.code === 'ENOENT' || error.code === 'EISDIR';
      if (!missing) console.error(error);
      response.writeHead(missing ? 404 : 500).end(missing ? 'Not found.' : 'Unable to read the requested file.');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createAppServer();
  server.on('error', error => { console.error(error); process.exitCode = 1; });
  server.listen(4173, '127.0.0.1', () => console.log('Open http://127.0.0.1:4173'));
}
