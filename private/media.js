const sourceDir = '/source';
const sourceName = 'input';
const inputPath = sourceDir + '/' + sourceName;
const maxSide = 8192;
const maxPixels = 40000000;

export async function mountInput(engine, file) {
  await engine.createDir(sourceDir);
  // WORKERFS reads slices of the original File on demand inside the worker.
  const mounted = await engine.mount('WORKERFS', {blobs:[{name:sourceName, data:file}]}, sourceDir);
  if (!mounted) throw new Error('The media engine could not open this file for reading.');
}

function checkDimensions(width, height) {
  if (!(width > 0 && height > 0)) throw new Error('Could not read the frame dimensions. The codec may be unsupported.');
  if (width * height > maxPixels || Math.max(width, height) > maxSide) {
    throw new Error('Frames must be at most 40 megapixels and no more than 8,192 pixels on either side.');
  }
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
  if (['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return { label:'GIF', image:true };
  if (first === 'RIFF') {
    const kind = ascii(bytes, 8, 4);
    if (kind === 'WEBP') {
      if (ascii(bytes, 12, 4) === 'VP8X' && (bytes[20] & 2)) {
        if (bytes.length < 30) throw new Error('The WebP header is incomplete.');
        const sizeAt = i => 1 + bytes[i] + (bytes[i+1] << 8) + (bytes[i+2] << 16);
        checkDimensions(sizeAt(24), sizeAt(27));
        return { label:'WebP', image:true, animatedWebP:true };
      }
      return { label:'WebP', image:true };
    }
    if (kind === 'WAVE') return { label:'WAV' };
    if (kind === 'AVI ') return { label:'AVI' };
  }
  if (['RF64','BW64','RIFX'].includes(first) && ascii(bytes, 8, 4) === 'WAVE') return { label:'WAV' };
  if (starts(66,77)) return { label:'BMP', image:true };
  if (starts(73,73,42,0) || starts(77,77,0,42)) return { label:'TIFF', image:true };
  if (first === 'OggS') return { label:'Ogg' };
  if (first === 'fLaC') return { label:'FLAC' };
  if (starts(26,69,223,163)) return { label:'Matroska / WebM' };
  if (bytes[0] === 255 && (bytes[1] & 246) === 240) return { label:'AAC' };
  if (starts(73,68,51) || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return { label:'MPEG audio' };
  if (ascii(bytes, 4, 4) === 'ftyp') {
    if (/^(avif|avis|heic|heix|mif1|msf1|hevc|hevx)$/.test(ascii(bytes, 8, 4))) throw new Error('HEIF and AVIF are not supported yet. Choose a PNG, JPEG, or WebP image.');
    return { label:'MP4 / MOV' };
  }
  // Older QuickTime files can start with a movie, padding or media-data atom.
  if (['moov','wide','mdat','free','skip'].includes(ascii(bytes, 4, 4))) return { label:'MP4 / MOV' };
  if (first === '%PDF' || starts(80,75,3,4)) throw new Error('This file is a document or archive. Choose an image, audio file, or video.');
  throw new Error('Unsupported file type. See the list of supported formats below.');
}
export const inputArgs = ['-protocol_whitelist', 'file', '-format_whitelist', 'png_pipe,apng,jpeg_pipe,gif,webp_pipe,bmp_pipe,tiff_pipe,mp3,aac,wav,flac,ogg,matroska,webm,mov,avi'];
export async function readReport(engine) {
  const entries = 'format=duration,bit_rate:stream=index,codec_type,width,height,display_aspect_ratio,duration,channels,sample_rate,bit_rate:stream_disposition=attached_pic:stream_side_data=rotation';
  const code = await engine.ffprobe(['-v','error',...inputArgs,'-show_entries',entries,'-of','json','-o','probe.json',inputPath], 25000);
  // This core can leave its return slot at -1 after writing a complete ffprobe report.
  try {
    if (code !== 0 && code !== -1) throw new Error();
    const report = JSON.parse(await engine.readFile('probe.json','utf8'));
    await engine.deleteFile('probe.json');
    return report;
  } catch { throw new Error('Could not read this media file. Check that it opens and uses a supported codec.'); }
}
export function identify(header, probe) {
  const streams = probe.streams || [];
  const video = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find(s => s.codec_type === 'audio');
  if ((!video && !audio) || (header.image && !video)) throw new Error('No readable media track was found in this file.');
  if (video) checkDimensions(video.width, video.height);
  const durations = [probe.format?.duration, video?.duration, audio?.duration].map(Number).filter(Number.isFinite);
  const duration = Math.max(0, ...durations);
  const kind = header.image ? 'image' : video ? 'video' : 'audio';
  if (kind !== 'image' && duration > 1800) throw new Error('This file is longer than 30 minutes. Choose a shorter recording.');
  const stillOnly = header.image && ['GIF','WebP','PNG','TIFF'].includes(header.label);
  const audioBitRate = Number(audio?.bit_rate) || (kind === 'audio' ? Number(probe.format?.bit_rate) : 0);
  return { kind, label:header.label, audio, video, audioBitRate, duration, stillOnly };
}
const audioFormats = ['mp3','wav','flac','ogg'];
const videoFormats = ['mp4','webm'];
const outputs = {
  convert: {image:['png','jpg','webp'], audio:audioFormats, video:videoFormats},
  compress: {image:['webp','jpg'], audio:['ogg','mp3'], video:videoFormats}
};
export function choices(info, mode) {
  if (mode === 'extract') return info.kind === 'video' && info.audio ? audioFormats : [];
  return outputs[mode]?.[info.kind] ?? [];
}

function lossyAudioArgs(info, mode, target, index, channels) {
  const preset = (target === 'mp3' ? [80000,160000,256000] : [48000,96000,160000])[index];
  if (mode !== 'compress') return ['-ac',channels,'-ar','48000','-b:a',String(preset)];

  const inputHz = Number(info.audio.sample_rate) || 48000;
  if (target === 'ogg') {
    // Vorbis quality mode also works for telephone audio outside its managed bitrate range.
    return ['-ac',channels,'-ar',String(Math.min(inputHz,48000)),'-q:a',String([0,3,5][index])];
  }
  const budget = info.audioBitRate > 0 ? info.audioBitRate * [0.5,0.75,0.9][index] : preset;
  const bitrate = Math.max(8000, Math.round(Math.min(preset, budget) / 1000) * 1000);
  const ceiling = Math.min(inputHz, bitrate < 32000 ? 24000 : 48000);
  const hz = [48000,44100,32000,24000,22050,16000,12000,11025,8000].find(rate => rate <= ceiling) || 8000;
  return ['-ac',channels,'-ar',String(hz),'-b:a',String(bitrate)];
}

function reducedRatio(width, height) {
  let a = width, b = height;
  while (b) [a,b] = [b,a % b];
  return [width / a,height / a];
}

const qualities = ['small','balanced','high'];
export function videoGeometry(video, mode, target, quality) {
  const side = mode === 'compress' ? [720,1280,1920][qualities.indexOf(quality)] : maxSide;
  const other = target === 'webm' ? 'MP4' : 'WebM';
  const unsupported = {side,supported:false,error:`This display ratio cannot be stored exactly in ${formats[target][0]} within the frame limits. Try ${other}.`};
  let {width,height} = video;
  const ratio = /^(\d+):(\d+)$/.exec(video.display_aspect_ratio);
  let [across,down] = ratio && ratio.slice(1).every(term => Number(term) > 0 && Number(term) <= 0x7fffffff)
    ? reducedRatio(Number(ratio[1]),Number(ratio[2])) : reducedRatio(width,height);
  const rotation = video.side_data_list?.find(entry => Number.isFinite(entry.rotation))?.rotation || 0;
  if (Math.abs(Math.abs(rotation) % 180 - 90) < 1) {
    [width,height] = [height,width];
    [across,down] = [down,across];
  }
  const shrink = Math.min(1,side / Math.max(width,height));
  const aspect = across / down;
  let outWidth, outHeight;
  if (target === 'webm') {
    // This WebM muxer stores integer display width and coded height. An exact
    // ratio needs a height that is a multiple of the reduced denominator.
    if (down > maxSide) return unsupported;
    outHeight = down * Math.max(1, Math.floor(height * shrink / down));
    outWidth = Math.max(Math.ceil(aspect),Math.round(width * Math.min(shrink, outHeight / height)));
    outWidth = Math.min(outWidth,Math.floor(maxPixels / outHeight));
  } else {
    // H.264 4:2:0 needs even coded dimensions. FFmpeg discards a pixel ratio
    // that would render either side narrower than one pixel (e.g. 1:4000).
    outWidth = 2 * Math.max(1,Math.floor(width * shrink / 2),Math.ceil(aspect / 2));
    outHeight = 2 * Math.max(1,Math.floor(height * shrink / 2),Math.ceil(down / across / 2));
  }
  const candidates = [[outWidth,outHeight]];
  if (target === 'mp4') {
    // An anamorphic source can have an exact 16-bit SAR at its native size
    // even if the rounded preset size would require a larger H.264 fraction.
    candidates.push([2*Math.ceil(width/2),2*Math.ceil(height/2)], [2*width,2*height]);
  }
  const sarLimit = target === 'mp4' ? 65535 : 0x7fffffff;
  for (const [w,h] of candidates) {
    if (!(w > 0 && h > 0 && w <= maxSide && h <= maxSide && w*h <= maxPixels)) continue;
    if (w*down < across || h*across < down) continue;
    const [sw,sh] = reducedRatio(across*h,down*w);
    if (sw > sarLimit || sh > sarLimit) continue;
    return {width:w,height:h,side,supported:true,filter:`scale=${w}:${h},setsar=${sw}/${sh}:max=${sarLimit}`};
  }
  return unsupported;
}

export function encodeArgs(info, mode, target, quality) {
  const index = qualities.indexOf(quality);
  if (!choices(info, mode).includes(target) || index === -1) throw new Error('Choose a supported format and quality preset.');
  const channels = String(Math.min(info.audio?.channels || 2, 2));
  const args = ['-hide_banner','-loglevel','error',...inputArgs,'-threads','1','-i',inputPath,'-map_metadata','-1','-map_chapters','-1','-sn','-dn'];
  if (info.kind === 'image') {
    args.push('-map','0:' + info.video.index,'-frames:v','1');
    if (target === 'webp') args.push('-c:v','libwebp','-quality', ['48','76','92'][index]);
    if (target === 'jpg') args.push('-c:v','mjpeg','-q:v',['12','6','2'][index]);
    if (target === 'png') args.push('-c:v','png','-compression_level','6');
  } else if (info.kind === 'audio' || mode === 'extract') {
    args.push('-map','0:' + info.audio.index,'-vn','-c:a', { mp3:'libmp3lame', wav:'pcm_s16le', flac:'flac', ogg:'libvorbis' }[target]);
    if (target === 'ogg' || target === 'mp3') args.push(...lossyAudioArgs(info,mode,target,index,channels));
  } else {
    args.push('-map','0:' + info.video.index);
    if (info.audio) args.push('-map','0:' + info.audio.index);
    const geometry = videoGeometry(info.video,mode,target,quality);
    if (!geometry.supported) throw new Error(geometry.error);
    args.push('-vf',geometry.filter,'-pix_fmt','yuv420p');
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

export async function encodeFile(engine, info, mode, target, quality, signal) {
  const path = 'output.' + target;
  let data;
  try {
    const code = await engine.exec(encodeArgs(info,mode,target,quality));
    if (code !== 0) throw new Error('Could not encode the file. Try a different output format or a smaller file.');
    data = await engine.readFile(path);
    if (!data.length) throw new Error('The media engine returned an empty file.');
  } finally {
    // Release MEMFS before allocating the downloadable Blob. A canceled worker
    // has already released its entire filesystem, including partial output.
    if (!signal.aborted) await engine.deleteFile(path).catch(() => {});
  }
  signal.throwIfAborted();
  return new Blob([data], {type:formats[target][1]});
}
