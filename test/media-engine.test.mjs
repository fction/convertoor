import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import createCore from '@ffmpeg/core';
import {encodeFile, identify, readReport, signature, videoGeometry} from '../private/media.js';

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

async function exportVideo(core,engine,info,target) {
  const blob = await encodeFile(engine,info,'compress',target,'small',new AbortController().signal);
  const path = 'encoded.' + target;
  core.FS.writeFile(path,new Uint8Array(await blob.arrayBuffer()));
  engine.ffprobe(['-v','error','-show_entries','stream=width,height,display_aspect_ratio','-of','json','-o','geometry.json',path],25000);
  const {streams:[geometry]} = JSON.parse(engine.readFile('geometry.json','utf8'));
  core.FS.unlink('geometry.json');
  return geometry;
}

test('MP4 and WebM keep the actual picture and exact display ratio of a one-pixel-wide source', async () => {
  const {core,engine,info} = await mediaFixture(['-i','color=white:s=4x4000:r=1,format=rgb24,crop=1:4000','-frames:v','1','-c:v','png','-f','avi']);
  assert.equal(info.video.width,1);
  for (const target of ['mp4','webm']) {
    const geometry = await exportVideo(core,engine,info,target);
    assert.equal(geometry.display_aspect_ratio,'1:4000');
    assert.equal(await engine.exec(['-i','encoded.'+target,'-frames:v','1','-pix_fmt','gray','-f','rawvideo','pixels']),0);
    const pixels = engine.readFile('pixels');
    assert.equal(pixels.length,geometry.width*geometry.height);
    assert.ok(pixels.every(value => value > 230));
    core.FS.unlink('pixels');
  }
});

test('an odd-width anamorphic source retains its exact display ratio in both containers', async () => {
  const {core,engine,info} = await mediaFixture(['-i','testsrc=s=13x1000:r=1,setsar=2/1','-frames:v','1','-c:v','png','-f','matroska']);
  assert.equal(info.video.display_aspect_ratio,'13:500');
  for (const target of ['mp4','webm']) {
    const geometry = await exportVideo(core,engine,info,target);
    assert.equal(geometry.display_aspect_ratio,'13:500');
    assert.ok(geometry.height <= 720);
  }
});

test('a one-pixel-high source keeps its 4000:1 ratio', async () => {
  const {core,engine,info} = await mediaFixture(['-i','testsrc=s=4000x1:r=1','-frames:v','1','-c:v','png','-f','avi']);
  for (const target of ['mp4','webm']) {
    assert.equal((await exportVideo(core,engine,info,target)).display_aspect_ratio,'4000:1');
  }
});

test('unrepresentable ratios stop before an oversized or distorted encode', () => {
  for (const target of ['mp4','webm']) {
    const impossible = videoGeometry({width:48,height:16,display_aspect_ratio:'999999:1'},'compress',target,'small');
    assert.equal(impossible.supported,false);
    assert.match(impossible.error,/display ratio/);
  }
  assert.equal(videoGeometry({width:800,height:600,display_aspect_ratio:'100001:67291'},'convert','mp4','balanced').supported,false);
  assert.equal(videoGeometry({width:800,height:600,display_aspect_ratio:'5:8193'},'convert','webm','balanced').supported,false);
});

test('a quarter turn rotates the display ratio along with the pixels', async () => {
  const {core,engine} = await mediaFixture(['-i','testsrc=s=80x140:r=1,setsar=2/1','-frames:v','1','-c:v','libx264','-pix_fmt','yuv420p','-f','mp4']);
  assert.equal(await engine.exec(['-i','/source/input','-c','copy','-metadata:s:v:0','rotate=90','rotated.mp4']),0);
  core.FS.writeFile('/source/input',engine.readFile('rotated.mp4'));
  const info = identify({label:'MP4 / MOV'},await readReport(engine));
  assert.equal(Math.abs(info.video.side_data_list[0].rotation),90);
  for (const target of ['mp4','webm']) {
    assert.equal((await exportVideo(core,engine,info,target)).display_aspect_ratio,'7:8');
  }
});
