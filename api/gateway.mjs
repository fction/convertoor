import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuredAccount, lifetime, ticket, validTicket, verifyPassword } from '../lib/account.mjs';
import { createLoginThrottle } from '../lib/login-throttle.mjs';
import { createBlobSessions, createLocalSessions } from '../lib/sessions.mjs';

const documents = new Map([
  ['studio', ['studio.html', 'text/html']],
  ['client', ['client.js', 'text/javascript']],
  ['media', ['media.js', 'text/javascript']],
  ['runtime', ['runtime.js', 'text/javascript']],
  ['webp-frame', ['webp-frame.js', 'text/javascript']],
  ['disk-output', ['disk-output.js', 'text/javascript']],
  ['engine-worker', ['engine-worker.js', 'text/javascript']],
  ['download-worker', ['download-worker.js', 'text/javascript']]
]);
const throttle = createLoginThrottle();
const sessions = process.env.VERCEL || process.env.NODE_ENV === 'production' ? createBlobSessions() : createLocalSessions();
let deriving = 0;
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};
async function body(req) {
  if (Number(req.headers['content-length']) > 2048) throw new Error();
  if (req.body !== undefined) {
    if (Buffer.byteLength(JSON.stringify(req.body)) > 2048) throw new Error();
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 2048) throw new Error();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function unavailable(res) {
  res.setHeader('Retry-After', '2');
  return json(res, 503, {error:'Session storage is temporarily unavailable. Please try again.'});
}
export default function gateway(req, res) { return handleGateway(req, res, sessions); }
export async function handleGateway(req, res, store) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const account = configuredAccount(process.env.CONVERTOOR_ACCOUNT);
  if (!account) return json(res, 503, { error: 'The owner has not set up access yet.' });
  const secure = Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production';
  const host = req.headers.host;
  const expectedOrigin = (secure ? 'https://' : 'http://') + host;
  const cookieName = secure ? '__Host-convertoor' : 'local_convertoor';
  const attributes = '; Path=/; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
  const url = new URL(req.url, 'http://localhost');
  const route = url.searchParams.get('view') || (url.pathname === '/studio' ? 'studio' : '');
  const session = (req.headers.cookie || '').split(/;\s*/).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
  const now = Date.now();
  if (['login', 'logout'].includes(route)) {
    if (req.method !== 'POST') return json(res, 405, {});
    if (req.headers.origin !== expectedOrigin || req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 403, {});
    if (route === 'logout') {
      if (validTicket(session, account, now)) {
        try { await store.revoke(session); } catch { return unavailable(res); }
      }
      res.setHeader('Set-Cookie', cookieName + '=; Max-Age=0' + attributes);
      return json(res, 200, { ok: true });
    }
    let fields;
    try { fields = await body(req); } catch { return json(res, 400, {}); }
    if (typeof fields?.login !== 'string' || typeof fields?.password !== 'string' || fields.login.length > 128 || fields.password.length > 256) return json(res, 400, {});
    if (deriving >= 2) {
      res.setHeader('Retry-After', '2');
      return json(res, 503, { error: 'Sign-in is busy. Try again in a moment.' });
    }
    const address = (process.env.VERCEL ? req.headers['x-vercel-forwarded-for'] : req.socket.remoteAddress) || 'unknown';
    const wait = throttle.reserve(address);
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      return json(res, 429, { error: 'Too many sign-in attempts. Try again later.' });
    }
    deriving++;
    let accepted;
    try { accepted = await verifyPassword(account, fields.login, fields.password); } finally { deriving--; }
    if (!accepted) return json(res, 401, { error: 'Check your username and password.' });
    throttle.clear(address);
    const issued = ticket(account, Date.now());
    try { await store.activate(issued); } catch { return unavailable(res); }
    res.setHeader('Set-Cookie', cookieName + '=' + issued + '; Max-Age=' + lifetime + attributes);
    return json(res, 200, { ok: true });
  }
  if (req.method !== 'GET') return json(res, 405, {});
  let active = false;
  if (validTicket(session, account, now)) {
    try { active = await store.active(session); } catch { return unavailable(res); }
  }
  const expires = Number(session.split('.')[0]);
  const remainingMs = expires - Date.now();
  if (!active || remainingMs <= 0) {
    if (route === 'studio') { res.writeHead(303, { Location: '/' }); return res.end(); }
    return json(res, 401, {});
  }
  if (route === 'session') {
    return json(res, 200, { login: account.login, expires, remainingMs });
  }
  const doc = documents.get(route);
  if (!doc) return json(res, 404, {});
  const content = await readFile(join(process.cwd(), 'private', doc[0]));
  res.writeHead(200, { 'Content-Type': doc[1] + '; charset=utf-8' });
  res.end(content);
}
