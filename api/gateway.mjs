import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuredAccount, lifetime, ticket, validTicket, verifyPassword } from '../lib/account.mjs';

const documents = new Map([['studio', ['studio.html', 'text/html']], ['client', ['client.js', 'text/javascript']], ['media', ['media.js', 'text/javascript']]]);
const attempts = new Map();
let deriving = 0;
function limited(address, now) {
  for (const [key, record] of attempts) if (record.until <= now) attempts.delete(key);
  const record = attempts.get(address) || { count: 0, until: now + 600000 };
  if (record.count >= 6 || attempts.size >= 4096 || deriving >= 2) return true;
  record.count++;
  attempts.set(address, record);
  return false;
}
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
export default async function gateway(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const account = configuredAccount(process.env.CONVERTOOR_ACCOUNT);
  if (!account) return json(res, 503, { error: 'Владелец ещё не настроил доступ.' });
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
      res.setHeader('Set-Cookie', cookieName + '=; Max-Age=0' + attributes);
      return json(res, 200, { ok: true });
    }
    let fields;
    try { fields = await body(req); } catch { return json(res, 400, {}); }
    if (typeof fields?.login !== 'string' || typeof fields?.password !== 'string' || fields.login.length > 128 || fields.password.length > 256) return json(res, 400, {});
    const address = (process.env.VERCEL ? req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] : req.socket.remoteAddress) || 'unknown';
    if (limited(address, now)) {
      res.setHeader('Retry-After', '600');
      return json(res, 429, { error: 'Слишком много попыток. Повторите через 10 минут.' });
    }
    deriving++;
    let accepted;
    try { accepted = await verifyPassword(account, fields.login, fields.password); } finally { deriving--; }
    if (!accepted) return json(res, 401, { error: 'Проверьте логин и пароль.' });
    attempts.delete(address);
    res.setHeader('Set-Cookie', cookieName + '=' + ticket(account, now) + '; Max-Age=' + lifetime + attributes);
    return json(res, 200, { ok: true });
  }
  if (req.method !== 'GET') return json(res, 405, {});
  if (!validTicket(session, account, now)) {
    if (route === 'studio') { res.writeHead(303, { Location: '/' }); return res.end(); }
    return json(res, 401, {});
  }
  if (route === 'session') return json(res, 200, { login: account.login, expires: Number(session.split('.')[0]) });
  const doc = documents.get(route);
  if (!doc) return json(res, 404, {});
  const content = await readFile(join(process.cwd(), 'private', doc[0]));
  res.writeHead(200, { 'Content-Type': doc[1] + '; charset=utf-8' });
  res.end(content);
}
