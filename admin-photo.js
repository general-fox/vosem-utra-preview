const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_PHOTO_BYTES = 100 * 1024 * 1024;
const ORIGINAL_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_EDGE = 2400;
const READ_ERROR = 'Не удалось прочитать фотографию. Выберите исправный файл JPG, PNG или WebP.';
const PREPARE_ERROR = 'Не удалось подготовить фотографию. Попробуйте выбрать её ещё раз или уменьшить размер изображения.';

export function photoTargetSize(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error(READ_ERROR);
  const ratio = Math.min(1, PHOTO_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

async function openPhoto(file, browser) {
  if (typeof browser.createImageBitmap === 'function') {
    try {
      // Decode with the camera's EXIF orientation before calculating the aspect ratio.
      const image = await browser.createImageBitmap(file, { imageOrientation: 'from-image' });
      return { image, width: image.width, height: image.height, dispose: () => image.close() };
    } catch { /* Image also supports browsers whose bitmap decoder cannot read this format. */ }
  }
  let image, url;
  const dispose = () => {
    if (image) { image.onload = image.onerror = null; image.src = ''; }
    if (url) browser.URL.revokeObjectURL(url);
  };
  try {
    image = new browser.Image();
    url = browser.URL.createObjectURL(file);
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(READ_ERROR));
      image.src = url;
    });
    return { image, width: image.naturalWidth, height: image.naturalHeight, dispose };
  } catch {
    dispose();
    throw new Error(READ_ERROR);
  }
}

async function jpegNeedsRotation(file) {
  // PHP re-encodes uploads without EXIF: bake camera rotation into the pixels first.
  // This check is only used for originals <= 5 MiB; large files are always prepared.
  const view = new DataView(await file.arrayBuffer());
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return true;
  let offset = 2;
  while (offset + 1 < view.byteLength) {
    if (view.getUint8(offset++) !== 0xff) return true;
    while (offset < view.byteLength && view.getUint8(offset) === 0xff) offset++;
    if (offset >= view.byteLength) return true;
    const marker = view.getUint8(offset++);
    if (marker === 0xda || marker === 0xd9) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > view.byteLength) return true;
    const end = offset + view.getUint16(offset);
    if (end <= offset + 2 || end > view.byteLength) return true;
    if (marker === 0xe1 && end - offset >= 16 && view.getUint32(offset + 2) === 0x45786966 && view.getUint16(offset + 6) === 0) {
      const tiff = offset + 8;
      const byteOrder = view.getUint16(tiff);
      if (![0x4949, 0x4d4d].includes(byteOrder)) return true;
      const little = byteOrder === 0x4949;
      if (view.getUint16(tiff + 2, little) !== 42) return true;
      const directory = tiff + view.getUint32(tiff + 4, little);
      if (directory < tiff + 8 || directory + 2 > end) return true;
      const count = view.getUint16(directory, little);
      if (directory + 2 + count * 12 > end) return true;
      for (let index = 0; index < count; index++) {
        const tag = directory + 2 + index * 12;
        if (view.getUint16(tag, little) !== 0x0112) continue;
        if (view.getUint16(tag + 2, little) !== 3 || view.getUint32(tag + 4, little) !== 1) return true;
        return view.getUint16(tag + 8, little) !== 1;
      }
    }
    offset = end;
  }
  return true;
}

// Accept the original camera file, but send a proportionate image sized for the site.
// Small originals retain their exact bytes, including their existing transparency.
export async function prepareAdminPhoto(file, browser = globalThis) {
  if (!file || !PHOTO_TYPES.has(file.type) || !Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_PHOTO_BYTES) {
    throw new Error('Выберите изображение JPG, PNG или WebP размером до 100 МБ.');
  }
  let source, canvas;
  try {
    source = await openPhoto(file, browser);
    const size = photoTargetSize(source.width, source.height);
    if (size.width === source.width && size.height === source.height && file.size <= ORIGINAL_PHOTO_BYTES) {
      let needsRotation = false;
      try { needsRotation = file.type === 'image/jpeg' && await jpegNeedsRotation(file); }
      catch { throw new Error(READ_ERROR); }
      if (!needsRotation) return file;
    }
    try {
      canvas = browser.document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d', { alpha: true });
      if (!context) throw new Error(PREPARE_ERROR);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(source.image, 0, 0, size.width, size.height);
      const prepared = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
      // Older browsers may return PNG when WebP encoding is unavailable. Both keep alpha.
      if (!prepared || !PHOTO_TYPES.has(prepared.type) || prepared.size <= 0 || prepared.size > MAX_PHOTO_BYTES) throw new Error(PREPARE_ERROR);
      return prepared;
    } catch { throw new Error(PREPARE_ERROR); }
  } finally {
    source?.dispose();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
