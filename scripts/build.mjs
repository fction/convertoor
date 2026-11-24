import { cp, mkdir, readdir } from 'node:fs/promises';
await mkdir('dist/vendor', { recursive: true });
await cp('public', 'dist', { recursive: true });
for (const entry of await readdir('node_modules/@ffmpeg/ffmpeg/dist/esm')) {
  if (entry.endsWith('.js')) await cp('node_modules/@ffmpeg/ffmpeg/dist/esm/' + entry, 'dist/vendor/' + entry);
}
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await cp('node_modules/@ffmpeg/core/dist/esm/' + name, 'dist/vendor/' + name);
}
