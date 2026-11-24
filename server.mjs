import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import gateway from './api/gateway.mjs';
const settings = JSON.parse(await readFile('vercel.json', 'utf8'));
const types = { '.css':'text/css', '.js':'text/javascript', '.html':'text/html', '.svg':'image/svg+xml', '.wasm':'application/wasm' };
const port = Number(process.env.PORT || 4173);
http.createServer(async (req, res) => {
  try {
    if (!['127.0.0.1:' + port, 'localhost:' + port].includes(req.headers.host)) { res.writeHead(403); return res.end(); }
    for (const {key, value} of settings.headers[0].headers) res.setHeader(key, value);
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/api/gateway' || path === '/studio') return await gateway(req, res);
    if (req.method !== 'GET' || !/^\/(?:|index\.html|style\.css|login\.js|mark\.svg|vendor\/[\w.-]+\.(?:js|wasm))$/.test(path)) { res.writeHead(404); return res.end(); }
    const file = join('dist', path === '/' ? 'index.html' : path);
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] });
    res.end(bytes);
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
}).listen(port, '127.0.0.1', () => console.log('Convertoor http://127.0.0.1:' + port));
