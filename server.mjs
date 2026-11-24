import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import gateway from './api/gateway.mjs';
const settings = JSON.parse(await readFile('vercel.json', 'utf8'));
const commonHeaders = settings.headers.find(rule => rule.source === '/(.*)').headers;
const coreHeaders = settings.headers.find(rule => rule.source === '/vendor/core/:version/:asset').headers;
const legacyTarget = settings.redirects.find(rule => rule.source === '/vendor/ffmpeg-core.:ext').destination;
const types = { '.css':'text/css', '.js':'text/javascript', '.html':'text/html', '.svg':'image/svg+xml', '.wasm':'application/wasm' };
const port = Number(process.env.PORT || 4173);
http.createServer(async (req, res) => {
  try {
    if (!['127.0.0.1:' + port, 'localhost:' + port].includes(req.headers.host)) { res.writeHead(403); return res.end(); }
    for (const {key, value} of commonHeaders) res.setHeader(key, value);
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/api/gateway' || path === '/studio') return await gateway(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, {Allow:'GET, HEAD'}); return res.end(); }
    const legacyCore = /^\/vendor\/ffmpeg-core\.(js|wasm)$/.exec(path);
    if (legacyCore) {
      res.writeHead(307, {Location:legacyTarget.replace(':ext',legacyCore[1])});
      return res.end();
    }
    const core = /^\/vendor\/core\/\d+\.\d+\.\d+\/ffmpeg-core\.(js|wasm)$/.test(path);
    if (!core && !/^\/(?:|index\.html|style\.css|login\.js|mark\.svg|vendor\/[\w.-]+\.js)$/.test(path)) { res.writeHead(404); return res.end(); }
    const file = join('dist', path === '/' ? 'index.html' : path);
    const {size} = await stat(file);
    if (core) for (const {key,value} of coreHeaders) res.setHeader(key,value);
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Content-Length':size });
    if (req.method === 'HEAD') return res.end();
    await pipeline(createReadStream(file), res);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    res.writeHead(error.code === 'ENOENT' ? 404 : 500);
    res.end();
  }
}).listen(port, '127.0.0.1', () => console.log('Convertoor http://127.0.0.1:' + port));
