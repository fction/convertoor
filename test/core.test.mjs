import test from 'node:test';
import assert from 'node:assert/strict';
import { newAccount, configuredAccount, ticket, validTicket, verifyPassword } from '../lib/account.mjs';
import { signature, identify, choices, encodeArgs } from '../private/media.js';
test('signed sessions expire, reject edits and rotate with account settings', async () => {
  const acc = await newAccount('owner','a test-only string');
  assert.equal(configuredAccount('{}'),undefined);
  assert.deepEqual(configuredAccount(JSON.stringify(acc)),acc);
  assert.ok(await verifyPassword(acc,'owner','a test-only string'));
  assert.equal(await verifyPassword(acc,'other','a test-only string'),false);
  const now = Date.now(), token = ticket(acc,now);
  assert.ok(validTicket(token,acc,now));
  assert.equal(validTicket(token,acc,now+3600000),false);
  assert.equal(validTicket(token.slice(1),acc,now),false);
  assert.equal(validTicket(token,{...acc,key:'a'.repeat(64)},now),false);
});
test('embedded cover art is not a video track', () => {
  const info=identify({label:'MP4 / MOV'},{streams:[{codec_type:'video',disposition:{attached_pic:1},index:0},{codec_type:'audio',index:1}]});
  assert.equal(info.kind,'audio');
  assert.deepEqual(choices(info,'extract'),[]);
  assert.ok(encodeArgs(info,'convert','mp3','balanced').includes('0:1'));
});
test('unknown documents and missing tracks are rejected', () => {
  assert.throws(()=>signature(Buffer.from('%PDF-1.7')));
  assert.throws(()=>signature(Buffer.from('not a media file')));
  assert.throws(()=>identify({label:'WAV'},{streams:[]}));
  assert.deepEqual(signature(Buffer.from('RIFFxxxxWAVE')), {label:'WAV'});
});
test('silent video offers only video formats', () => {
  const info=identify({label:'Matroska'},{streams:[{codec_type:'video',index:0,width:16,height:16}]});
  assert.deepEqual(choices(info,'extract'),[]);
  assert.deepEqual(choices(info,'compress'),['mp4','webm']);
});

test('the longest known media duration is used when metadata is incomplete', () => {
  const audio = {codec_type:'audio',index:0,duration:'25.25'};
  assert.equal(identify({label:'WAV'},{streams:[audio],format:{duration:'N/A'}}).duration,25.25);
  assert.throws(() => identify({label:'WAV'},{streams:[{...audio,duration:'1801'}],format:{duration:'3'}}), /30 minutes/);
});

test('the classifier recognizes RF64, older QuickTime headers, and ADTS AAC', () => {
  assert.equal(signature(Buffer.from('RF64xxxxWAVE')).label,'WAV');
  assert.equal(signature(Buffer.from([0,0,0,8,119,105,100,101])).label,'MP4 / MOV');
  assert.equal(signature(Buffer.from([255,241,80,128])).label,'AAC');
});

test('only animated extended WebP uses the first-frame decoder', () => {
  const header = Buffer.alloc(32);
  header.write('RIFF');
  header.write('WEBPVP8X',8);
  header.writeUInt32LE(10,16);
  header.writeUIntLE(47,24,3);
  header.writeUIntLE(31,27,3);
  assert.equal(signature(header).animatedWebP,undefined);
  header[20] = 2;
  assert.equal(signature(header).animatedWebP,true);
  header.writeUIntLE(8192,24,3);
  assert.throws(() => signature(header), /8,192/);
});
