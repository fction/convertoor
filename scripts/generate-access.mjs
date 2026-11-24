import { randomBytes } from 'node:crypto';
import { newAccount } from '../lib/account.mjs';
if (process.stdout.isTTY) throw new Error('Используйте scripts/access.ps1 для защищённого сохранения.');
const login = 'fction';
const password = randomBytes(24).toString('base64url');
const account = await newAccount(login, password);
process.stdout.write(JSON.stringify({login,password,account}));
