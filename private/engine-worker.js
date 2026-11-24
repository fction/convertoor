// The FFmpeg wrapper imports this core factory inside its dedicated worker.
// Regular files and commands keep using the packaged worker implementation.
export default async function createDiskCapableCore(config) {
  const {coreURL} = await import('/vendor/engine.js');
  const {default:createCore} = await import(coreURL);
  const core = await createCore(config);
  let output;
  const upstream = self.onmessage;
  self.onmessage = async event => {
    const {id, type, data} = event.data;
    const opening = type === 'MOUNT' && data.fsType === 'OPFS';
    const closing = type === 'UNMOUNT' && output && data.mountPoint === output.path;
    if (!opening && !closing) return upstream.call(self, event);
    try {
      if (opening) {
        if (output || !/^output\.(mp4|webm)$/.test(data.mountPoint)) throw new Error('Invalid video output.');
        if (!data.options.file.createSyncAccessHandle) throw new Error('This browser cannot write video exports to disk. Try a current version of Edge, Chrome, Firefox, or Safari.');
        const handle = await data.options.file.createSyncAccessHandle();
        try { output = attachDiskFile(core.FS, data.mountPoint, handle); }
        catch (error) { handle.close(); throw error; }
      } else {
        try { output.close(); } finally { output = null; }
      }
      self.postMessage({id, type, data:true});
    } catch (error) {
      self.postMessage({id, type:'ERROR', data:error.message || String(error)});
    }
  };
  return core;
}

// A regular seekable file permits MP4 faststart to reopen the same path and move
// media to make room for the index. Each read/write works on the codec's buffer.
export function attachDiskFile(fs, path, handle) {
  const node = fs.create(path);
  const original = node.node_ops;
  let ioFailure;
  function diskOperation(action) {
    try { return action(); }
    catch (error) {
      ioFailure = error;
      throw new fs.ErrnoError(error.name === 'QuotaExceededError' ? 51 : 29); // ENOSPC, EIO
    }
  }
  node.node_ops = {
    getattr:original.getattr,
    setattr(node, {size, ...attributes}) {
      original.setattr(node, attributes);
      if (size !== undefined) {
        diskOperation(() => handle.truncate(size));
        node.usedBytes = size;
      }
    }
  };
  node.stream_ops = {
    llseek:node.stream_ops.llseek,
    read(stream, buffer, offset, length, position) {
      return diskOperation(() => handle.read(buffer.subarray(offset, offset + length), {at:position}));
    },
    write(stream, buffer, offset, length, position) {
      return diskOperation(() => {
        let written = 0;
        while (written < length) {
          const count = handle.write(buffer.subarray(offset + written, offset + length), {at:position + written});
          if (!count) throw new Error('The browser could not write to local storage.');
          written += count;
        }
        node.usedBytes = Math.max(node.usedBytes, position + written);
        return written;
      });
    }
  };
  return {
    path,
    close() {
      try {
        if (ioFailure) throw ioFailure;
        handle.flush();
      } finally {
        try { handle.close(); } finally { fs.unlink(path); }
      }
    }
  };
}
