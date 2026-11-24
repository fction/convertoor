import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('a download has a one-use URL and holds the disk lease until its body is read', async () => {
  const origin = 'https://studio.example';
  const scope = origin + '/api/video-download/';
  const listeners = {};
  let leased = false;
  const locks = {async request(name, options, callback) {
    if (options.ifAvailable) return callback(null); // The studio still owns this file.
    assert.equal(options.mode,'shared');
    leased = true;
    try { return await callback({name}); } finally { leased = false; }
  }};
  const self = {location:{origin}, registration:{scope}, addEventListener:(type,fn) => { listeners[type] = fn; }};
  const source = await readFile(new URL('../private/download-worker.js',import.meta.url),'utf8');
  runInNewContext(source,{self,navigator:{locks},File,Response,TransformStream,URL,crypto,TextEncoder,TextDecoder,setTimeout,clearTimeout});
  const file = new File(['small video payload'],crypto.randomUUID()+'.mp4');
  let url, handoff;
  listeners.message({
    source:{url:origin+'/studio'}, data:{file,filename:'Clip 01.mp4'},
    ports:[{postMessage:message => {url = message.url;}, close(){}}],
    waitUntil:promise => {handoff = promise;}
  });
  assert.ok(url.startsWith(scope));
  assert.ok(!url.includes(file.name));
  assert.equal(leased,true);
  const request = {url,method:'GET',mode:'navigate',signal:new AbortController().signal};
  let response, streaming;
  listeners.fetch({request, respondWith:value => {response=value;}, waitUntil:value => {streaming=value;}});
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  assert.match(response.headers.get('Content-Disposition'),/Clip%2001.mp4/);
  listeners.fetch({request,respondWith:value => assert.equal(value.status,404)});
  assert.equal(leased,true);
  assert.equal(await response.text(),'small video payload');
  await Promise.all([streaming,handoff]);
  assert.equal(leased,false);
});
