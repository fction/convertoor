import {mountInput} from '/api/gateway?view=media';

// Only the public WASM binary is shared between jobs. Each file gets a new
// worker and filesystem, even in browsers that do not HTTP-cache large assets.
let binary;
function wasmURL(coreURL, signal) {
  if (!binary) {
    const asset = {controller:new AbortController()};
    binary = asset;
    const cancel = () => { if (binary === asset) releaseRuntime(); };
    signal.addEventListener('abort', cancel, {once:true});
    asset.ready = (async () => {
      const response = await fetch(new URL('ffmpeg-core.wasm', coreURL), {signal:asset.controller.signal});
      if (!response.ok) throw new Error('Could not load the media engine. Check your connection and try again.');
      const blob = await response.blob();
      asset.controller.signal.throwIfAborted();
      asset.url = URL.createObjectURL(blob);
      return asset.url;
    })().catch(error => {
      if (binary === asset) binary = null;
      throw error;
    }).finally(() => signal.removeEventListener('abort', cancel));
  }
  return binary.ready;
}
export function releaseRuntime() {
  if (!binary) return;
  binary.controller.abort();
  if (binary.url) URL.revokeObjectURL(binary.url);
  binary = null;
}

async function firstWebpFrame(file, signal) {
  const worker = new Worker('/api/gateway?view=webp-frame', {type:'module'});
  let cancel;
  try {
    return await new Promise((resolve, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, {once:true});
      const failed = () => reject(new Error('This browser could not decode the first frame of the animated WebP.'));
      worker.onerror = failed;
      worker.onmessage = ({data}) => data instanceof Blob && data.size ? resolve(data) : failed();
      worker.postMessage(file.slice(0, file.size, 'image/webp'));
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    worker.terminate();
  }
}

export async function openMedia(file, header, signal) {
  signal.throwIfAborted();
  const input = header.animatedWebP ? await firstWebpFrame(file, signal) : file;
  const {FFmpeg, coreURL} = await import('/vendor/engine.js');
  signal.throwIfAborted();
  const wasm = await wasmURL(coreURL, signal);
  signal.throwIfAborted();
  const engine = new FFmpeg();
  const terminate = () => engine.terminate();
  signal.addEventListener('abort', terminate, {once:true});
  try {
    await engine.load({coreURL:new URL('/api/gateway?view=engine-worker', location.href).href, wasmURL:wasm});
    await mountInput(engine, input);
    return engine;
  } catch (error) {
    signal.removeEventListener('abort', terminate);
    terminate();
    throw error;
  }
}
