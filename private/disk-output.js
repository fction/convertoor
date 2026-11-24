const directoryName = 'convertoor-video-exports';
const lockName = name => directoryName + '/' + name;
const downloads = new WeakMap();
let registration;

async function downloadWorker() {
  if (!navigator.serviceWorker) throw new Error('Video downloads require service workers. Allow site storage and try again.');
  const scope = '/api/video-download/';
  registration ??= navigator.serviceWorker.register('/api/gateway?view=download-worker', {scope}).catch(error => {
    registration = null;
    throw error;
  });
  const installed = await registration;
  const worker = installed.active || installed.waiting || installed.installing;
  if (!worker) throw new Error('The video download handler is unavailable. Try downloading again.');
  if (worker.state !== 'activated') await new Promise((resolve,reject) => {
    const changed = () => {
      if (worker.state === 'activated' || worker.state === 'redundant') {
        worker.removeEventListener('statechange', changed);
        if (worker.state === 'activated') resolve();
        else { registration = null; reject(new Error('Could not start the video download handler. Try again.')); }
      }
    };
    worker.addEventListener('statechange', changed);
    changed();
  });
  return worker;
}

async function startDownload(file, filename) {
  const worker = await downloadWorker();
  const channel = new MessageChannel();
  try {
    const url = await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('The download handler did not respond. Try again.')), 15000);
      channel.port1.onmessage = ({data}) => {
        clearTimeout(timer);
        if (data.url) resolve(data.url);
        else reject(new Error('The video is no longer available. Export the file again.'));
      };
      worker.postMessage({file, filename}, [channel.port2]);
    });
    const link = document.createElement('a');
    link.href = url;
    // A navigation starts the download worker in its own scope. The studio page
    // itself never needs to be controlled by a service worker.
    link.click();
  } finally { channel.port1.close(); }
}

export function downloadVideo(file, filename) {
  const handoffs = downloads.get(file);
  if (!handoffs) return Promise.reject(new Error('The video has already been cleared.'));
  const started = startDownload(file, filename);
  handoffs.add(started);
  return started.finally(() => handoffs.delete(started));
}

async function removeFile(directory, name) {
  // Worker termination can briefly retain the synchronous handle on a canceled export.
  const deadline = performance.now() + 30000;
  let delay = 50;
  while (true) {
    try { await directory.removeEntry(name); return; }
    catch (error) {
      if (error.name === 'NotFoundError') return;
      if (error.name !== 'NoModificationAllowedError' || performance.now() >= deadline) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 2000);
  }
}

export async function cleanAbandonedExports() {
  if (!navigator.storage?.getDirectory || !navigator.locks) return;
  const root = await navigator.storage.getDirectory();
  let directory;
  try { directory = await root.getDirectoryHandle(directoryName); }
  catch (error) { if (error.name === 'NotFoundError') return; throw error; }
  for await (const [name, entry] of directory) {
    if (entry.kind !== 'file' || !/^[a-f0-9-]{36}\.(mp4|webm)$/.test(name)) continue;
    await navigator.locks.request(lockName(name), {ifAvailable:true}, async lock => {
      if (lock) await removeFile(directory, name);
    });
  }
}

async function temporaryVideo(target, signal) {
  if (!navigator.storage?.getDirectory || !navigator.locks) {
    throw new Error('This browser cannot write video exports to disk. Open the studio in a current browser with local storage enabled.');
  }
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(directoryName, {create:true});
  const name = crypto.randomUUID() + '.' + target;
  let unlock;
  const lifetime = new Promise(resolve => { unlock = resolve; });
  let finished;
  // Acquire the cross-tab lease before creating the entry. A tab crash releases
  // the lease automatically, making its temporary file eligible for cleanup.
  const file = await new Promise((resolve, reject) => {
    finished = navigator.locks.request(lockName(name), {mode:'shared'}, async () => {
      signal.throwIfAborted();
      resolve(await directory.getFileHandle(name, {create:true}));
      await lifetime;
    }).then(() => navigator.locks.request(lockName(name), () => removeFile(directory, name)));
    finished.catch(reject);
  });
  return {file, dispose() { unlock(); return finished; }};
}

export async function encodeVideoToDisk(engine, args, target, signal) {
  const path = 'output.' + target;
  if (!['mp4','webm'].includes(target) || args.at(-1) !== path) throw new Error('Invalid video output.');
  const temp = await temporaryVideo(target, signal);
  try {
    signal.throwIfAborted();
    await engine.mount('OPFS', {file:temp.file}, path);
    let code;
    try { code = await engine.exec(args); }
    finally { if (!signal.aborted) await engine.unmount(path); }
    signal.throwIfAborted();
    if (code !== 0) throw new Error('Could not encode the video. Check the available disk space or try another format.');
    const blob = await temp.file.getFile();
    signal.throwIfAborted();
    if (!blob.size) throw new Error('The media engine returned an empty video.');
    const handoffs = new Set();
    downloads.set(blob, handoffs);
    return {blob, async dispose() {
      downloads.delete(blob);
      // If Clear follows Download immediately, wait until the browser's reader
      // owns its shared lease before queuing the exclusive deletion.
      await Promise.allSettled(handoffs);
      return temp.dispose();
    }};
  } catch (error) {
    await temp.dispose().catch(() => {});
    if (error?.name === 'QuotaExceededError' || /quota exceeded|quota has been exceeded|not enough space/i.test(String(error))) {
      throw new Error('There is not enough space for the video. Free up local disk space and try again.');
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}
