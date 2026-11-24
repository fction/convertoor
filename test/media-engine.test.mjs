import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import createCore from '@ffmpeg/core';
import {encodeArgs, identify, readReport, signature} from '../private/media.js';

test('the shipped WASM reads a real probe report and encodes stereo Vorbis', async () => {
  globalThis.self = {location:{href:'http://localhost/'}};
  const wasmBinary = await readFile(new URL(import.meta.resolve('@ffmpeg/core/wasm')));
  const core = await createCore({wasmBinary});
  core.FS.mkdir('/source');
  const generated = core.exec('-f','lavfi','-i','sine=frequency=500:sample_rate=48000','-t','0.1','-ac','2','-f','wav','/source/input');
  assert.equal(generated,0);
  core.reset();
  const header = signature(core.FS.readFile('/source/input'));
  const report = await readReport({
    ffprobe(args,timeout) { core.setTimeout(timeout); const code=core.ffprobe(...args); core.reset(); return code; },
    readFile(file,encoding) { return core.FS.readFile(file,{encoding}); }
  });
  const info = identify(header,report);
  assert.equal(info.kind,'audio');
  assert.equal(info.audio.channels,2);
  assert.equal(core.exec(...encodeArgs(info,'compress','ogg','balanced')),0);
  const bytes = core.FS.readFile('output.ogg');
  assert.equal(new TextDecoder().decode(bytes.subarray(0,4)),'OggS');
});
