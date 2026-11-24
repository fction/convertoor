import test from 'node:test';
import assert from 'node:assert/strict';
import {closeSync, fsyncSync, ftruncateSync, openSync, readSync, writeSync} from 'node:fs';
import {mkdtemp, readFile, rm, rmdir, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import createCore from '@ffmpeg/core';
import {attachDiskFile} from '../private/engine-worker.js';

test('the packaged MP4 muxer seeks on disk for faststart without accumulating its payload in MEMFS', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convertoor-mux-'));
  const path = join(directory,'test.mp4');
  t.after(async () => { await rm(path, {force:true}); await rmdir(directory); });
  const wasmBinary = await readFile(new URL(import.meta.resolve('@ffmpeg/core/wasm')));
  globalThis.self = {location:{href:'http://localhost/'}};
  const core = await createCore({wasmBinary});
  const fd = openSync(path,'wx+');
  let maxWrite = 0, reads = 0;
  const handle = {
    read(buffer,{at}) { reads++; return readSync(fd,buffer,0,buffer.length,at); },
    write(buffer,{at}) {
      maxWrite = Math.max(maxWrite,buffer.length);
      // Short writes are permitted by the disk interface.
      return writeSync(fd,buffer,0,Math.min(buffer.length,2048),at);
    },
    truncate:size => ftruncateSync(fd,size), flush:() => fsyncSync(fd), close:() => closeSync(fd)
  };
  const file = attachDiskFile(core.FS,'output.mp4',handle);
  try {
    const code = core.exec('-f','lavfi','-i','testsrc2=s=320x240:r=20','-t','1','-c:v','libx264','-preset','ultrafast','-movflags','+faststart','output.mp4');
    assert.equal(code,0);
    const node = core.FS.lookupPath('output.mp4').node;
    assert.equal(node.contents,null);
    assert.equal(node.usedBytes,(await stat(path)).size);
    assert.ok(reads > 0 && maxWrite > 0 && maxWrite < node.usedBytes);
  } finally { file.close(); }
  assert.equal(core.FS.analyzePath('output.mp4').exists,false);
  const bytes = await readFile(path);
  assert.equal(bytes.subarray(4,8).toString(),'ftyp');
  assert.ok(bytes.indexOf('moov') > 0 && bytes.indexOf('moov') < bytes.indexOf('mdat'));
});
