import { randomBytes, scrypt, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const options = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
export async function newAccount(login, password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(password, salt, 32, options)).toString('hex');
  return { login, salt, hash, key: randomBytes(32).toString('hex') };
}
export function configuredAccount(value) {
  try {
    const account = JSON.parse(value);
    if (typeof account?.login === 'string' && account.login.length > 0 && account.login.length <= 128
      && typeof account.salt === 'string' && /^[a-f0-9]{32}$/.test(account.salt)
      && typeof account.hash === 'string' && /^[a-f0-9]{64}$/.test(account.hash)
      && typeof account.key === 'string' && /^[a-f0-9]{64}$/.test(account.key)) return account;
  } catch { /* Unconfigured deployments stay locked. */ }
}
export async function verifyPassword(account, login, password) {
  const digest = await derive(password, account.salt, 32, options);
  return timingSafeEqual(digest, Buffer.from(account.hash, 'hex')) && login === account.login;
}
const sign = (value, account) => createHmac('sha256', Buffer.from(account.key, 'hex')).update('convertoor.session.v2\0' + account.hash + '.' + value).digest('base64url');
export const lifetime = 3600;
export function ticket(account, now) {
  const data = String(now + lifetime * 1000) + '.' + randomBytes(16).toString('hex');
  return data + '.' + sign(data, account);
}
export function validTicket(value, account, now) {
  if (typeof value !== 'string' || value.length !== 90 || !/^\d{13}\.[0-9a-f]{32}\.[\w-]{43}$/.test(value)) return false;
  const [expiry, nonce, signature] = value.split('.');
  return Number(expiry) > now && timingSafeEqual(Buffer.from(signature), Buffer.from(sign(expiry + '.' + nonce, account)));
}
