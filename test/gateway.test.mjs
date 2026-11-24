import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import gateway from '../api/gateway.mjs';
import {lifetime,newAccount} from '../lib/account.mjs';
import {createLoginThrottle} from '../lib/login-throttle.mjs';

test('a full throttle still serves known addresses and expires only elapsed windows', () => {
  const throttle = createLoginThrottle(2);
  assert.equal(throttle.reserve('first',0),0);
  assert.equal(throttle.reserve('second',15000),0);
  for (let i=0; i<5; i++) assert.equal(throttle.reserve('first',40000),0);
  assert.equal(throttle.reserve('first',40000),560);
  assert.equal(throttle.reserve('third',599000),1);
  assert.equal(throttle.reserve('third',600000),0);
  assert.equal(throttle.reserve('second',600000),0);
  throttle.clear('third');
  assert.equal(throttle.reserve('first',600000),0);
});

test('private resources require a session and the server reports its remaining lifetime', async t => {
  const account = await newAccount('reader','sample password');
  const previous = process.env.CONVERTOOR_ACCOUNT;
  process.env.CONVERTOOR_ACCOUNT = JSON.stringify(account);
  t.after(() => {
    if (previous === undefined) delete process.env.CONVERTOOR_ACCOUNT;
    else process.env.CONVERTOOR_ACCOUNT = previous;
  });
  const server = http.createServer(gateway);
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const origin = 'http://127.0.0.1:' + server.address().port;
  const endpoint = origin + '/api/gateway?view=';
  const guest = await fetch(endpoint + 'webp-frame');
  assert.equal(guest.status,401);
  assert.match(guest.headers.get('Cache-Control'),/no-store/);

  const publicOrigin = process.env.VERCEL || process.env.NODE_ENV === 'production' ? origin.replace('http:', 'https:') : origin;
  const signedIn = await fetch(endpoint + 'login',{
    method:'POST', headers:{Origin:publicOrigin,'Content-Type':'application/json'},
    body:JSON.stringify({login:'reader',password:'sample password'})
  });
  assert.equal(signedIn.status,200);
  const cookie = signedIn.headers.get('Set-Cookie').split(';')[0];
  const session = await (await fetch(endpoint + 'session',{headers:{Cookie:cookie}})).json();
  assert.equal(session.login,'reader');
  assert.ok(session.remainingMs > 0 && session.remainingMs <= lifetime * 1000);
  assert.ok(Math.abs(session.expires - session.remainingMs - Date.now()) < 5000);
  const module = await fetch(endpoint + 'webp-frame',{headers:{Cookie:cookie}});
  assert.equal(module.status,200);
  assert.match(module.headers.get('Content-Type'),/javascript/);
});
