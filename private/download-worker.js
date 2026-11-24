// Only a studio tab can hand off a disk-backed File. Each URL is valid for one
// navigation; the HTTP path contains neither the OPFS name nor the export name.
const pending = new Map();
const scope = self.registration.scope;
const directoryName = 'convertoor-video-exports';

async function removeIfOwnerClosed(name) {
  await navigator.locks.request(directoryName + '/' + name, {ifAvailable:true}, async lock => {
    if (!lock) return;
    try {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(directoryName);
      await directory.removeEntry(name);
    } catch (error) { if (error.name !== 'NotFoundError') throw error; }
  });
}

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('message', event => {
  const port = event.ports[0];
  if (!port) return;
  const {file, filename} = event.data || {};
  const client = event.source?.url && new URL(event.source.url);
  const studio = client?.origin === self.location.origin && (client.pathname === '/studio' ||
    (client.pathname === '/api/gateway' && client.searchParams.get('view') === 'studio'));
  if (!studio ||
      !(file instanceof File) || !/^[a-f0-9-]{36}\.(mp4|webm)$/.test(file.name) || typeof filename !== 'string') {
    port.postMessage({error:true}); return;
  }
  const token = crypto.randomUUID();
  const url = scope + token;
  event.waitUntil(navigator.locks.request(directoryName + '/' + file.name, {mode:'shared'}, async () => {
    let finish;
    const reading = new Promise(resolve => { finish = resolve; });
    const timer = setTimeout(finish, 15000);
    pending.set(url, {file, filename, finish, timer});
    try { port.postMessage({url}); await reading; }
    finally { clearTimeout(timer); pending.delete(url); port.close(); }
  }).then(() => removeIfOwnerClosed(file.name)).catch(() => port.postMessage({error:true})));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const entry = pending.get(request.url);
  if (!entry || request.method !== 'GET' || request.mode !== 'navigate') {
    event.respondWith(new Response(null,{status:404,headers:{'Cache-Control':'no-store'}})); return;
  }
  pending.delete(request.url);
  clearTimeout(entry.timer);
  const {file, filename} = entry;
  const safeName = new TextDecoder().decode(new TextEncoder().encode(filename)).replace(/[\u0000-\u001f\u007f/\\]/g,'_');
  const escaped = encodeURIComponent(safeName).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16));
  const ext = file.name.split('.').pop();
  const transfer = new TransformStream();
  // Keep the shared lease until the download consumer has read the final chunk
  // or canceled the stream, even if the user clears the result or closes the tab.
  event.waitUntil(file.stream().pipeTo(transfer.writable, {signal:request.signal}).catch(() => {}).finally(entry.finish));
  event.respondWith(new Response(transfer.readable, {headers:{
    'Content-Type':'video/' + ext,
    'Content-Length':String(file.size),
    'Content-Disposition':`attachment; filename="export.${ext}"; filename*=UTF-8''${escaped}`,
    'Cache-Control':'private, no-store',
    'X-Content-Type-Options':'nosniff'
  }}));
});
