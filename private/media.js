export const limit = 100 * 1024 * 1024;
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
  if (starts(73,68,51) || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return { label:'MPEG-аудио' };
  if (ascii(bytes, 4, 4) === 'ftyp') {
    if (/^(avif|avis|heic|heix|mif1|msf1|hevc|hevx)$/.test(ascii(bytes, 8, 4))) throw new Error('Это HEIF или AVIF. Для этой версии выберите PNG, JPEG или WebP.');
    return { label:'MP4 / MOV' };
  }
  if (first === '%PDF' || starts(80,75,3,4)) throw new Error('Это документ или архив. Выберите изображение, аудио или видео.');
  throw new Error('Тип файла не поддерживается. Список доступных форматов приведён ниже.');
}
export const inputArgs = ['-protocol_whitelist', 'file', '-format_whitelist', 'png_pipe,apng,jpeg_pipe,gif,webp_pipe,bmp_pipe,tiff_pipe,mp3,aac,wav,flac,ogg,matroska,webm,mov,avi'];
export function identify(header, probe) {
  const streams = probe.streams || [];
  const video = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find(s => s.codec_type === 'audio');
  if ((!video && !audio) || (header.image && !video)) throw new Error('В файле не удалось прочитать медиадорожку.');
  if (video && (!video.width || !video.height || video.width * video.height > 40000000 || Math.max(video.width,video.height) > 8192)) throw new Error('Размер кадра выходит за пределы 40 Мп или 8192 пикселей по стороне.');
  const duration = Number(probe.format?.duration || video?.duration || audio?.duration || 0);
  if (duration > 1800) throw new Error('Файл длиннее 30 минут. Выберите более короткую запись.');
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
  if (!choices(info, mode).includes(target) || !['small','balanced','high'].includes(quality)) throw new Error('Выберите доступный формат и качество.');
  const index = ['small','balanced','high'].indexOf(quality);
  const args = [...inputArgs, '-threads','1','-i','input','-map_metadata','-1','-map_chapters','-1','-sn','-dn'];
  if (info.kind === 'image') {
    args.push('-map','0:' + info.video.index,'-frames:v','1');
    if (target === 'webp') args.push('-c:v','libwebp','-quality', ['48','76','92'][index]);
    if (target === 'jpg') args.push('-c:v','mjpeg','-q:v',['12','6','2'][index]);
    if (target === 'png') args.push('-c:v','png','-compression_level','6');
  } else if (info.kind === 'audio' || mode === 'extract') {
    args.push('-map','0:' + info.audio.index,'-vn','-c:a', { mp3:'libmp3lame', wav:'pcm_s16le', flac:'flac', ogg:'libvorbis' }[target]);
    if (target === 'ogg' || target === 'mp3') args.push('-ac','2','-ar','48000','-b:a',(target === 'ogg' ? ['48k','96k','160k'] : ['80k','160k','256k'])[index]);
  } else {
    args.push('-map','0:' + info.video.index);
    if (info.audio) args.push('-map','0:' + info.audio.index);
    const side = mode === 'compress' ? [720,1280,1920][index] : 8192;
    args.push('-vf','scale=w=min('+side+'\\,iw):h=min('+side+'\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,pad=max(2\\,iw):max(2\\,ih)','-pix_fmt','yuv420p');
    if (target === 'mp4') args.push('-c:v','libx264','-preset','ultrafast','-crf',['32','26','20'][index],'-c:a','aac','-movflags','+faststart');
    else args.push('-c:v','libvpx','-deadline','realtime','-cpu-used','6','-crf',['38','28','12'][index],'-b:v',['500k','1200k','2500k'][index],'-c:a','libvorbis');
    if (info.audio) args.push('-ac','2','-ar','48000','-b:a',['64k','96k','160k'][index]);
  }
  return [...args,'-threads','1','output.' + target];
}
