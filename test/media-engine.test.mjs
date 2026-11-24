import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import createCore from '@ffmpeg/core';
import {encodeFile, identify, readReport, signature} from '../private/media.js';

async function mediaFixture(inputArgs) {
  globalThis.self = {location:{href:'http://localhost/'}};
  const wasmBinary = await readFile(new URL(import.meta.resolve('@ffmpeg/core/wasm')));
  const core = await createCore({wasmBinary});
  core.FS.mkdir('/source');
  assert.equal(core.exec('-f','lavfi',...inputArgs,'/source/input'),0);
  core.reset();
  const engine = {
    async exec(args) { const code = core.exec(...args); core.reset(); return code; },
    ffprobe(args,timeout) { core.setTimeout(timeout); const code = core.ffprobe(...args); core.reset(); return code; },
    async deleteFile(file) { core.FS.unlink(file); },
    readFile(file,encoding) { return core.FS.readFile(file,{encoding}); }
  };
  const input = engine.readFile('/source/input');
  const report = await readReport(engine);
  assert.equal(core.FS.analyzePath('probe.json').exists,false);
  assert.equal(report.format.tags,undefined);
  return {core,engine,info:identify(signature(input),report),size:input.length};
}

test('the shipped WASM encodes stereo Vorbis and releases its temporary files', async () => {
  const {core,engine,info} = await mediaFixture(['-i','sine=frequency=500:sample_rate=48000','-t','0.1','-ac','2','-f','wav']);
  assert.equal(info.kind,'audio');
  assert.equal(info.audio.channels,2);
  const blob = await encodeFile(engine,info,'compress','ogg','balanced',new AbortController().signal);
  assert.equal(await blob.slice(0,4).text(),'OggS');
  assert.equal(core.FS.analyzePath('output.ogg').exists,false);
});

test('balanced MP3 compression respects an already low bitrate and sample rate', async () => {
  const {core,engine,info,size} = await mediaFixture(['-i','sine=frequency=500:sample_rate=22050','-t','2','-c:a','libmp3lame','-b:a','48k','-f','mp3']);
  const result = await encodeFile(engine,info,'compress','mp3','balanced',new AbortController().signal);
  assert.ok(result.size > 0 && result.size < size);
  core.FS.writeFile('/source/input',new Uint8Array(await result.arrayBuffer()));
  const report = await readReport(engine);
  assert.equal(report.streams[0].sample_rate,'22050');
  assert.ok(Math.abs(Number(report.format.duration)-info.duration) < 0.1);
});

test('scaling a one-pixel-wide source retains its picture', async () => {
  const {core,engine,info} = await mediaFixture(['-i','color=white:s=4x4000:r=1,format=rgb24,crop=1:4000','-frames:v','1','-c:v','png','-f','avi']);
  assert.equal(info.video.width,1);
  const blob = await encodeFile(engine,info,'compress','mp4','small',new AbortController().signal);
  core.FS.writeFile('encoded.mp4',new Uint8Array(await blob.arrayBuffer()));
  assert.equal(await engine.exec(['-i','encoded.mp4','-frames:v','1','-pix_fmt','gray','-f','rawvideo','pixels']),0);
  const pixels = engine.readFile('pixels');
  assert.equal(pixels.length,2*720);
  assert.ok(pixels.every(value => value > 230));
});
