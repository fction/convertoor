// The pinned FFmpeg build cannot decode animated WebP. Let the browser compose
// its first frame, then pass a lossless PNG to the regular export pipeline.
self.onmessage = async ({data: file}) => {
  try {
    const bitmap = await createImageBitmap(file);
    let canvas;
    try {
      if (bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 40000000) throw new Error();
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
    } finally {
      bitmap.close();
    }
    self.postMessage(await canvas.convertToBlob({type:'image/png'}));
  } catch {
    self.postMessage(null);
  }
};
