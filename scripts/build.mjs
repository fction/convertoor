import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
const {version} = JSON.parse(await readFile('node_modules/@ffmpeg/core/package.json', 'utf8'));
const coreDir = 'vendor/core/' + version;
await mkdir('dist/' + coreDir, { recursive: true });
await cp('public', 'dist', { recursive: true });
for (const entry of await readdir('node_modules/@ffmpeg/ffmpeg/dist/esm')) {
  if (entry.endsWith('.js')) await cp('node_modules/@ffmpeg/ffmpeg/dist/esm/' + entry, 'dist/vendor/' + entry);
}
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await cp('node_modules/@ffmpeg/core/dist/esm/' + name, 'dist/' + coreDir + '/' + name);
  // Previous local builds put a second copy at the legacy redirect path.
  await rm('dist/vendor/' + name, {force:true});
}
await writeFile('dist/vendor/engine.js', [
  "export {FFmpeg} from './index.js';",
  "export const coreURL = new URL('./core/" + version + "/ffmpeg-core.js', import.meta.url).href;",
  ''
].join('\n'));
