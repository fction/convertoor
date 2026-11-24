const sourceDir = '/source';
const sourceName = 'input';
const inputPath = sourceDir + '/' + sourceName;

export async function mountInput(engine, file) {
  await engine.createDir(sourceDir);
  // WORKERFS reads slices of the original File on demand inside the worker.
  const mounted = await engine.mount('WORKERFS', {blobs:[{name:sourceName, data:file}]}, sourceDir);
  if (!mounted) throw new Error('The media engine could not open this file for reading.');
}
export const formats = {
  jpg: ['JPEG', 'image/jpeg'], png: ['PNG', 'image/png'], webp: ['WebP', 'image/webp'],
  mp3: ['MP3', 'audio/mpeg'], wav: ['WAV', 'audio/wav'], flac: ['FLAC', 'audio/flac'], ogg: ['Ogg Vorbis', 'audio/ogg'],
  mp4: ['MP4 · H.264', 'video/mp4'], webm: ['WebM · VP8', 'video/webm']
};
const ascii = (b, at, len) => String.fromCharCode(...b.subarray(at, at + len));
export function signature(bytes) {
  const starts = (...prefix) => prefix.every((v, i) => bytes[i] === v);
  const first = ascii(bytes, 0, 4);
  if (starts(0x89,80,78,71,13,10,26,10)) return { label:'PNG', image:true };
  if (starts(255,216,255)) return { label:'JPEG', image:true };
  if (first === 'GIF8') return { label:'GIF', image:true };
  if (first === 'RIFF') {
    const kind = ascii(bytes, 8, 4);
    if (kind === 'WEBP') return { label:'WebP', image:true };
    if (kind === 'WAVE') return { label:'WAV' };
    if (kind === 'AVI ') return { label:'AVI' };
  }
  if (starts(66,77)) return { label:'BMP', image:true };
  if (starts(73,73,42,0) || starts(77,77,0,42)) return { label:'TIFF', image:true };
  if (first === 'OggS') return { label:'Ogg' };
  if (first === 'fLaC') return { label:'FLAC' };
  if (starts(26,69,223,163)) return { label:'Matroska / WebM' };
  if (starts(73,68,51) || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return { label:'MPEG audio' };
  if (ascii(bytes, 4, 4) === 'ftyp') {
    if (/^(avif|avis|heic|heix|mif1|msf1|hevc|hevx)$/.test(ascii(bytes, 8, 4))) throw new Error('HEIF and AVIF are not supported yet. Choose a PNG, JPEG, or WebP image.');
    return { label:'MP4 / MOV' };
  }
  if (first === '%PDF' || starts(80,75,3,4)) throw new Error('This file is a document or archive. Choose an image, audio file, or video.');
  throw new Error('Unsupported file type. See the list of supported formats below.');
}
export const inputArgs = ['-protocol_whitelist', 'file', '-format_whitelist', 'png_pipe,apng,jpeg_pipe,gif,webp_pipe,bmp_pipe,tiff_pipe,mp3,aac,wav,flac,ogg,matroska,webm,mov,avi'];
export async function readReport(engine) {
  const code = await engine.ffprobe(['-v','error',...inputArgs,'-show_streams','-show_format','-of','json','-o','probe.json',inputPath], 25000);
  // This core can leave its return slot at -1 after writing a complete ffprobe report.
  try {
    if (code !== 0 && code !== -1) throw new Error();
    return JSON.parse(await engine.readFile('probe.json','utf8'));
  } catch { throw new Error('Could not read this media file. Check that it opens and uses a supported codec.'); }
}
export function identify(header, probe) {
  const streams = probe.streams || [];
  const video = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find(s => s.codec_type === 'audio');
  if ((!video && !audio) || (header.image && !video)) throw new Error('No readable media track was found in this file.');
  if (video && (!video.width || !video.height || video.width * video.height > 40000000 || Math.max(video.width,video.height) > 8192)) throw new Error('Frames must be at most 40 megapixels and no more than 8,192 pixels on either side.');
  const duration = Number(probe.format?.duration || video?.duration || audio?.duration || 0);
  if (duration > 1800) throw new Error('This file is longer than 30 minutes. Choose a shorter recording.');
  const kind = header.image ? 'image' : video ? 'video' : 'audio';
  const stillOnly = header.image && ['GIF','WebP','PNG','TIFF'].includes(header.label);
  return { kind, label:header.label, audio, video, duration, stillOnly };
}
export function choices(info, mode) {
  if (mode === 'extract') return info.kind === 'video' && info.audio ? ['mp3','wav','flac','ogg'] : [];
  if (mode === 'compress') return { image:['webp','jpg'], audio:['ogg','mp3'], video:['mp4','webm'] }[info.kind];
  return { image:['png','jpg','webp'], audio:['mp3','wav','flac','ogg'], video:['mp4','webm'] }[info.kind];
}
export function encodeArgs(info, mode, target, quality) {
  if (!choices(info, mode).includes(target) || !['small','balanced','high'].includes(quality)) throw new Error('Choose a supported format and quality preset.');
  const index = ['small','balanced','high'].indexOf(quality);
  const channels = String(Math.min(info.audio?.channels || 2, 2));
  const args = [...inputArgs, '-threads','1','-i',inputPath,'-map_metadata','-1','-map_chapters','-1','-sn','-dn'];
  if (info.kind === 'image') {
    args.push('-map','0:' + info.video.index,'-frames:v','1');
    if (target === 'webp') args.push('-c:v','libwebp','-quality', ['48','76','92'][index]);
    if (target === 'jpg') args.push('-c:v','mjpeg','-q:v',['12','6','2'][index]);
    if (target === 'png') args.push('-c:v','png','-compression_level','6');
  } else if (info.kind === 'audio' || mode === 'extract') {
    args.push('-map','0:' + info.audio.index,'-vn','-c:a', { mp3:'libmp3lame', wav:'pcm_s16le', flac:'flac', ogg:'libvorbis' }[target]);
    if (target === 'ogg' || target === 'mp3') args.push('-ac',channels,'-ar','48000','-b:a',(target === 'ogg' ? ['48k','96k','160k'] : ['80k','160k','256k'])[index]);
  } else {
    args.push('-map','0:' + info.video.index);
    if (info.audio) args.push('-map','0:' + info.audio.index);
    const side = mode === 'compress' ? [720,1280,1920][index] : 8192;
    args.push('-vf','scale=w=min('+side+'\\,iw):h=min('+side+'\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,pad=max(2\\,iw):max(2\\,ih)','-pix_fmt','yuv420p');
    if (target === 'mp4') args.push('-c:v','libx264','-preset',mode === 'compress' ? 'veryfast' : 'ultrafast','-crf',(mode === 'compress' ? ['34','28','23'] : ['32','26','20'])[index],'-c:a','aac','-movflags','+faststart');
    else args.push('-c:v','libvpx','-deadline','realtime','-cpu-used','6','-crf',['38','28','12'][index],'-b:v',['500k','1200k','2500k'][index],'-c:a','libvorbis');
    if (info.audio) {
      const profileRate = [64000,96000,160000][index];
      const sourceRate = Number(info.audio.bit_rate) || profileRate;
      const rate = mode === 'compress' ? Math.max(48000,Math.min(sourceRate,profileRate)) : profileRate;
      args.push('-ac',channels,'-ar','48000','-b:a',String(rate));
    }
  }
  return [...args,'-threads','1','output.' + target];
}
