import {FFmpeg} from '/vendor/index.js';
import {mountInput, formats, signature, readReport, identify, choices, encodeArgs} from '/api/gateway?view=media';
const el = id => document.getElementById(id);
const api = '/api/gateway?view=';
const labels = {image:'Image', audio:'Audio', video:'Video'};
const actions = {convert:'Convert', compress:'Compress', extract:'Extract audio'};
const size = n => n < 1024 ? n + ' B' : Intl.NumberFormat('en', {maximumFractionDigits:1}).format(n / (n < 1048576 ? 1024 : 1048576)) + (n < 1048576 ? ' KiB' : ' MiB');
let job, resultURL, expiry;
const note = message => { el('status').textContent = message; };
function discardOutput() {
  if (resultURL) URL.revokeObjectURL(resultURL);
  resultURL = undefined;
  el('download').removeAttribute('href');
  el('result').hidden = true;
}
function reset(message = '') {
  if (job) { clearTimeout(job.timer); job.engine?.terminate(); }
  job = null;
  discardOutput();
  el('file').value = '';
  el('file-info').hidden = true;
  el('drop').hidden = false;
  el('cancel').hidden = true;
  el('progress').hidden = true;
  el('settings').disabled = true;
  el('mode').replaceChildren(new Option('Choose a file'));
  el('format').replaceChildren(new Option('—'));
  el('hint').textContent = '';
  note(message);
}
function profiles() {
  discardOutput();
  const lossless = ['png','wav','flac'].includes(el('format').value);
  el('quality').disabled = lossless;
  el('hint').textContent = lossless ? 'This format uses a fixed export preset.' : '';
  if (job?.info?.stillOnly) el('hint').textContent += ' For animations and multipage images, only the first frame or page is exported.';
}
function options() {
  const mode = el('mode').value;
  el('format').replaceChildren(...choices(job.info, mode).map(key => new Option(formats[key][0], key)));
  el('run').firstChild.textContent = actions[mode] + ' ';
  profiles();
}
function armTimeout(task, ms) {
  clearTimeout(task.timer);
  task.timer = setTimeout(() => { if (job === task) reset('Processing stopped responding. Try a smaller file or a lower quality preset.'); }, ms);
}
function busy(task, text, ms) {
  el('settings').disabled = true;
  el('clear').hidden = true;
  el('cancel').hidden = false;
  el('progress').hidden = false;
  el('progress').removeAttribute('value');
  note(text);
  armTimeout(task, ms);
}
function ready(task) {
  clearTimeout(task.timer);
  el('cancel').hidden = true;
  el('progress').hidden = true;
  el('clear').hidden = false;
  el('settings').disabled = false;
}
async function selectFile(file) {
  reset();
  if (!file) return;
  if (!file.size) return note('This file is empty. Choose another file.');
  const task = { file };
  job = task;
  el('drop').hidden = true;
  el('file-info').hidden = false;
  el('filename').textContent = file.name;
  el('metadata').textContent = size(file.size);
  busy(task, 'Detecting file type…', 120000);
  try {
    const header = signature(new Uint8Array(await file.slice(0,32).arrayBuffer()));
    if (job !== task) return;
    const engine = task.engine = new FFmpeg();
    note('Loading the media engine in your browser…');
    await engine.load({coreURL:location.origin + '/vendor/ffmpeg-core.js', wasmURL:location.origin + '/vendor/ffmpeg-core.wasm'});
    if (job !== task) return;
    await mountInput(engine, file);
    const info = task.info = identify(header, await readReport(engine));
    if (job !== task) return;
    const detail = [labels[info.kind],info.label,size(file.size)];
    if (info.video) detail.push(info.video.width + ' × ' + info.video.height);
    if (info.duration > 0 && info.kind !== 'image') detail.push(Math.floor(info.duration / 60) + ' min ' + Math.floor(info.duration % 60) + ' s');
    el('metadata').textContent = detail.join(' · ');
    const modes = ['convert','compress'];
    if (info.kind === 'video' && info.audio) modes.push('extract');
    el('mode').replaceChildren(...modes.map(key => new Option(actions[key],key)));
    el('quality').value = 'balanced';
    options(); ready(task); note('');
  } catch(error) {
    if (job === task) reset(error instanceof Error ? error.message : 'Could not open the file. Try a different format.');
  }
}
async function convert() {
  const task = job;
  if (!task?.info || el('settings').disabled) return;
  discardOutput();
  const mode = el('mode').value, target = el('format').value;
  const stallTimeout = 5 * 60 * 1000;
  busy(task, 'Processing the file on your device…', stallTimeout);
  let lastTime = -1, lastProgress = -1;
  const onProgress = ({progress, time}) => {
    if (job !== task) return;
    if (time > lastTime || progress > lastProgress) {
      lastTime = Math.max(lastTime, time);
      lastProgress = Math.max(lastProgress, progress);
      armTimeout(task, stallTimeout);
    }
    if (progress > 0 && progress <= 1) el('progress').value = Math.min(99,progress*100);
  };
  task.engine.on('progress',onProgress);
  try {
    const result = await task.engine.exec(encodeArgs(task.info,mode,target,el('quality').value));
    if (result !== 0) throw new Error('Could not encode the file. Try a different output format or a smaller file.');
    const data = await task.engine.readFile('output.'+target);
    if (!data.length) throw new Error('The media engine returned an empty file.');
    if (job !== task) return;
    const blob = new Blob([data],{type:formats[target][1]});
    resultURL = URL.createObjectURL(blob);
    el('download').href = resultURL;
    el('download').download = (task.file.name.replace(/\.[^.]+$/,'') || 'result') + '-export.' + target;
    const delta = Math.round((1 - blob.size / task.file.size)*100);
    el('result-info').textContent = size(task.file.size) + ' → ' + size(blob.size) + ' · ' + (delta > 0 ? delta + '% smaller' : delta < 0 ? -delta + '% larger' : 'about the same size');
    el('result').hidden = false; note('');
  } catch(error) {
    if (job === task) note(error instanceof Error ? error.message : 'Processing stopped. Try a different file.');
  } finally {
    task.engine.off('progress',onProgress);
    if (job === task) {
      await task.engine.deleteFile('output.'+target).catch(() => {});
      if (job === task) ready(task);
    }
  }
}
function leave() { reset(); clearTimeout(expiry); location.replace('/'); }
async function checkSession() {
  try {
    const response = await fetch(api+'session',{cache:'no-store'});
    if (!response.ok) return leave();
    const session = await response.json();
    el('user').textContent = session.login;
    clearTimeout(expiry);
    expiry = setTimeout(leave,Math.max(0,session.expires-Date.now()));
  } catch { leave(); }
}
el('logout').onclick = async () => {
  try {
    const r = await fetch(api+'logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    if (!r.ok) throw new Error();
    leave();
  } catch { note('Could not sign out. Check your connection and try again.'); }
};
el('file').onchange = e => selectFile(e.target.files[0]);
el('drop').ondragover = e => { e.preventDefault(); el('drop').classList.add('drag'); };
el('drop').ondragleave = () => el('drop').classList.remove('drag');
el('drop').ondrop = e => {
  e.preventDefault(); el('drop').classList.remove('drag');
  if (e.dataTransfer.files.length !== 1) return note('Choose one file at a time.');
  selectFile(e.dataTransfer.files[0]);
};
el('clear').onclick = () => reset();
el('cancel').onclick = () => reset('Processing canceled.');
el('mode').onchange = options;
el('format').onchange = profiles;
el('quality').onchange = discardOutput;
el('run').onclick = convert;
window.addEventListener('pageshow',checkSession);
window.addEventListener('pagehide',() => reset());
