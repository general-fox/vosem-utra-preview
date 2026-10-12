import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PHOTO_BYTES, photoTargetSize, prepareAdminPhoto } from '../admin-photo.js';

const photo = (size = 1024, type = 'image/jpeg') => ({ size, type, arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer });

function browser({ width = 6000, height = 4000, fallback = false, bitmapError = false, imageError = false,
  contextMissing = false, encodingError = false, output = { type: 'image/webp', size: 450000 } } = {}) {
  const log = { closes: 0, revokes: [], creates: 0, draw: null, encoding: null };
  const context = { drawImage(...args) { log.draw = args; } };
  const canvas = { width: 0, height: 0, getContext(type, options) { log.context = { type, options }; return contextMissing ? null : context; },
    toBlob(callback, type, quality) { log.encoding = { type, quality }; if (encodingError) throw new Error('Encoding failed'); callback(output); } };
  const bitmap = { width, height, close() { log.closes++; } };
  const environment = {
    document: { createElement(tag) { assert.equal(tag, 'canvas'); log.creates++; return canvas; } },
    URL: { createObjectURL(file) { log.urlFile = file; return 'blob:photo-test'; }, revokeObjectURL(url) { log.revokes.push(url); } },
    Image: class {
      constructor() { this.naturalWidth = width; this.naturalHeight = height; log.image = this; }
      set src(value) { log.imageSrc = value; if (value) queueMicrotask(() => imageError ? this.onerror() : this.onload()); }
    },
  };
  if (!fallback) environment.createImageBitmap = async (file, options) => {
    log.decoded = file; log.decodeOptions = options;
    if (bitmapError) throw new Error('Bitmap format unsupported');
    return bitmap;
  };
  return { environment, log, context, canvas, bitmap, output };
}

test('photo dimensions fit the site without cropping, stretching or enlarging', () => {
  assert.deepEqual(photoTargetSize(8000, 6000), { width: 2400, height: 1800 });
  assert.deepEqual(photoTargetSize(6000, 8000), { width: 1800, height: 2400 });
  assert.deepEqual(photoTargetSize(640, 480), { width: 640, height: 480 });
  assert.deepEqual(photoTargetSize(40000, 1), { width: 2400, height: 1 });
  assert.throws(() => photoTargetSize(0, 200), /прочитать фотографию/);
  assert.throws(() => photoTargetSize(Infinity, 200), /прочитать фотографию/);
});

test('the complete 100 MiB source is accepted, oriented and resized to a high-quality transparent WebP', async () => {
  const original = photo(MAX_PHOTO_BYTES, 'image/png');
  const app = browser({ width: 8000, height: 6000 });
  assert.equal(await prepareAdminPhoto(original, app.environment), app.output);
  assert.equal(app.log.decoded, original);
  assert.deepEqual(app.log.decodeOptions, { imageOrientation: 'from-image' });
  assert.deepEqual(app.log.draw, [app.bitmap, 0, 0, 2400, 1800]);
  assert.deepEqual(app.log.context, { type: '2d', options: { alpha: true } });
  assert.equal(app.context.imageSmoothingEnabled, true); assert.equal(app.context.imageSmoothingQuality, 'high');
  assert.deepEqual(app.log.encoding, { type: 'image/webp', quality: 0.9 });
  assert.equal(app.log.closes, 1); assert.equal(app.canvas.width, 0); assert.equal(app.canvas.height, 0);
});

test('small originals are byte-preserved while large dimensions or excess bytes trigger preparation', async () => {
  const original = photo(5 * 1024 * 1024, 'image/png');
  const small = browser({ width: 2400, height: 1800 });
  assert.equal(await prepareAdminPhoto(original, small.environment), original);
  assert.equal(small.log.creates, 0); assert.equal(small.log.closes, 1);
  const highResolution = browser();
  await prepareAdminPhoto(photo(500000), highResolution.environment);
  assert.deepEqual(highResolution.log.draw.slice(1), [0, 0, 2400, 1600]);
  const largeFile = browser({ width: 1200, height: 800 });
  await prepareAdminPhoto(photo(6 * 1024 * 1024), largeFile.environment);
  assert.deepEqual(largeFile.log.draw.slice(1), [0, 0, 1200, 800]);
});

test('invalid source files are rejected before decoding and report the 100 MiB limit', async () => {
  for (const original of [photo(MAX_PHOTO_BYTES + 1), photo(0), photo(100, 'image/svg+xml'), photo(NaN), null]) {
    const app = browser();
    await assert.rejects(prepareAdminPhoto(original, app.environment), /JPG, PNG или WebP размером до 100 МБ/);
    assert.equal(app.log.decoded, undefined); assert.equal(app.log.creates, 0);
  }
});

test('canvas failures report an actionable error and release decoded image and canvas memory', async () => {
  for (const options of [{ output: null }, { output: { type: 'image/webp', size: 0 } }, { encodingError: true }, { contextMissing: true }]) {
    const app = browser(options);
    await assert.rejects(prepareAdminPhoto(photo(), app.environment), /Не удалось подготовить фотографию/);
    assert.equal(app.log.closes, 1); assert.equal(app.canvas.width, 0); assert.equal(app.canvas.height, 0);
  }
  const invalidDimensions = browser({ width: 0 });
  await assert.rejects(prepareAdminPhoto(photo(), invalidDimensions.environment), /прочитать фотографию/);
  assert.equal(invalidDimensions.log.closes, 1); assert.equal(invalidDimensions.log.creates, 0);
});

test('Image fallback works without bitmap support, or after a bitmap decode failure, and revokes its URL', async () => {
  for (const options of [{ fallback: true }, { bitmapError: true }]) {
    const app = browser({ ...options, width: 4000, height: 6000 });
    await prepareAdminPhoto(photo(), app.environment);
    assert.deepEqual(app.log.draw.slice(1), [0, 0, 1600, 2400]);
    assert.deepEqual(app.log.revokes, ['blob:photo-test']); assert.equal(app.log.imageSrc, '');
    assert.equal(app.log.image.onload, null); assert.equal(app.log.image.onerror, null);
    assert.equal(app.canvas.width, 0); assert.equal(app.canvas.height, 0);
  }
  const small = browser({ fallback: true, width: 400, height: 600 });
  const original = photo(); assert.equal(await prepareAdminPhoto(original, small.environment), original);
  assert.deepEqual(small.log.revokes, ['blob:photo-test']); assert.equal(small.log.creates, 0);
});

test('corrupt photos and fallback encoding failures also free temporary object URLs', async () => {
  const unreadable = browser({ fallback: true, imageError: true });
  await assert.rejects(prepareAdminPhoto(photo(), unreadable.environment), /прочитать фотографию/);
  assert.deepEqual(unreadable.log.revokes, ['blob:photo-test']); assert.equal(unreadable.log.creates, 0);
  const encoding = browser({ fallback: true, output: null });
  await assert.rejects(prepareAdminPhoto(photo(), encoding.environment), /подготовить фотографию/);
  assert.deepEqual(encoding.log.revokes, ['blob:photo-test']); assert.equal(encoding.canvas.width, 0);
});

test('an older encoder may return transparent PNG without being treated as a broken upload', async () => {
  const app = browser({ output: { type: 'image/png', size: 6000000 } });
  assert.equal(await prepareAdminPhoto(photo(), app.environment), app.output);
  assert.equal(app.log.context.options.alpha, true);
});

function orientedPhoto(orientation, little = true) {
  const bytes = new Uint8Array(40), data = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8, 0xff, 0xe1, 0, 34, 69, 120, 105, 102, 0, 0]);
  data.setUint16(12, little ? 0x4949 : 0x4d4d);
  data.setUint16(14, 42, little); data.setUint32(16, 8, little);
  data.setUint16(20, 1, little); data.setUint16(22, 0x0112, little);
  data.setUint16(24, 3, little); data.setUint32(26, 1, little); data.setUint16(30, orientation, little);
  data.setUint16(38, 0xffd9);
  return { type: 'image/jpeg', size: bytes.length, arrayBuffer: async () => bytes.buffer };
}

test('small camera JPEGs bake EXIF rotation or mirroring into the pixels before the server strips metadata', async () => {
  for (const little of [true, false]) {
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const original = orientedPhoto(orientation, little);
      const app = browser({ width: 800, height: 1200 });
      const result = await prepareAdminPhoto(original, app.environment);
      if (orientation === 1) { assert.equal(result, original); assert.equal(app.log.creates, 0); }
      else { assert.equal(result, app.output); assert.deepEqual(app.log.draw.slice(1), [0, 0, 800, 1200]); }
      assert.equal(app.log.closes, 1);
    }
  }
});

test('unreadable JPEG metadata produces a clear error while freeing the decoded image', async () => {
  const original = { ...photo(), arrayBuffer: async () => { throw new Error('File was removed'); } };
  const app = browser({ width: 800, height: 600 });
  await assert.rejects(prepareAdminPhoto(original, app.environment), /прочитать фотографию/);
  assert.equal(app.log.closes, 1); assert.equal(app.log.creates, 0);
});
