// A minimal baseline TIFF reader, for the images in an IVIS (Living Image) export folder (spec 8.7).
//
// Why not a library: the app has no build step and takes no runtime dependency without asking (spec 12), and
// what Living Image writes is the plainest TIFF there is. Every file in the public S-BIAD3647 and Figshare
// 24970335 folders (luminescent.TIF, photograph.TIF, readbias.TIF, background.TIF, readbiasonly.TIF) is
// little-endian, one sample per pixel, 16 bits unsigned, BlackIsZero, uncompressed (Compression 1), stored in
// strips of 8–17 rows. So that is what is read here, plus the near relatives a different Living Image version
// or a re-save in Fiji might produce: big-endian byte order, 8-bit pixels, one strip or many, tiles not.
//
// Anything else (LZW or deflate compression, colour, floats, tiles) is refused with a sentence that says what
// the file is, rather than read as noise: a flux worked out from misread pixels would look like a number.
// Only the first image (IFD) is read; Living Image writes one per file.

const TAG = { width: 256, height: 257, bits: 258, compression: 259, photometric: 262, stripOffsets: 273, samples: 277, rowsPerStrip: 278, stripBytes: 279, planar: 284, sampleFormat: 339, tileWidth: 322 };
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

/**
 * Read a TIFF.
 * @param {ArrayBuffer|ArrayBufferView} input
 * @returns {{width: number, height: number, bits: 8|16, data: Uint8Array|Uint16Array, littleEndian: boolean, strips: number}}
 *   `data` holds the pixels row by row, top row first, as unsigned integers
 */
export function readTiff(input) {
  const u8 = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (u8.length < 8) throw new Error('readTiff: the file is too short to be a TIFF');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const order = String.fromCharCode(u8[0], u8[1]);
  if (order !== 'II' && order !== 'MM') throw new Error('readTiff: not a TIFF (no II or MM byte-order mark)');
  const le = order === 'II';
  if (dv.getUint16(2, le) !== 42) throw new Error(dv.getUint16(2, le) === 43 ? 'readTiff: a BigTIFF, which is not read here' : 'readTiff: not a TIFF (no 42 after the byte order)');
  const ifd = dv.getUint32(4, le);
  if (ifd + 2 > u8.length) throw new Error('readTiff: the first image directory lies past the end of the file');
  const n = dv.getUint16(ifd, le);
  const tags = new Map();
  for (let i = 0; i < n; i++) {
    const at = ifd + 2 + 12 * i;
    if (at + 12 > u8.length) break;
    const tag = dv.getUint16(at, le), type = dv.getUint16(at + 2, le), count = dv.getUint32(at + 4, le);
    const size = (SIZE[type] || 1) * count;
    const where = size <= 4 ? at + 8 : dv.getUint32(at + 8, le);
    const read = (k) => {
      const p = where + k * (SIZE[type] || 1);
      if (type === 3) return dv.getUint16(p, le);
      if (type === 4) return dv.getUint32(p, le);
      if (type === 5) return dv.getUint32(p, le) / (dv.getUint32(p + 4, le) || 1);
      return u8[p];
    };
    // Only the numeric tags are wanted; a long ASCII description is skipped without being read.
    const vals = [];
    if (type !== 2 && where + size <= u8.length) for (let k = 0; k < count; k++) vals.push(read(k));
    tags.set(tag, vals);
  }
  const one = (t, dflt) => (tags.get(t)?.length ? tags.get(t)[0] : dflt);
  const width = one(TAG.width), height = one(TAG.height);
  if (!width || !height) throw new Error('readTiff: no image width or height');
  const bits = one(TAG.bits, 1), compression = one(TAG.compression, 1), samples = one(TAG.samples, 1), format = one(TAG.sampleFormat, 1);
  if (tags.has(TAG.tileWidth)) throw new Error('readTiff: a tiled TIFF, which is not read here (Living Image writes strips)');
  if (compression !== 1) throw new Error(`readTiff: compressed (scheme ${compression}); only uncompressed TIFFs are read, as Living Image writes them`);
  if (samples !== 1) throw new Error(`readTiff: ${samples} samples per pixel; only grayscale images are read`);
  if (bits !== 8 && bits !== 16) throw new Error(`readTiff: ${bits} bits per pixel; only 8 and 16 are read`);
  if (format !== 1) throw new Error('readTiff: signed or floating-point pixels, which are not read here');
  const offsets = tags.get(TAG.stripOffsets) || [];
  const counts = tags.get(TAG.stripBytes) || [];
  if (!offsets.length) throw new Error('readTiff: no strip offsets');
  const bpp = bits / 8, need = width * height * bpp;
  const raw = new Uint8Array(need);
  let filled = 0;
  for (let s = 0; s < offsets.length && filled < need; s++) {
    const len = Math.min(counts[s] ?? need - filled, need - filled, u8.length - offsets[s]);
    if (len <= 0) throw new Error(`readTiff: strip ${s + 1} lies past the end of the file`);
    raw.set(u8.subarray(offsets[s], offsets[s] + len), filled);
    filled += len;
  }
  if (filled < need) throw new Error(`readTiff: the file holds ${filled} of the ${need} bytes the image needs`);
  let data;
  if (bits === 8) data = raw;
  else {
    data = new Uint16Array(width * height);
    const rv = new DataView(raw.buffer);
    for (let i = 0; i < data.length; i++) data[i] = rv.getUint16(2 * i, le);
  }
  return { width, height, bits, data, littleEndian: le, strips: offsets.length };
}

/**
 * Write a baseline TIFF (uncompressed, one strip, little-endian). Only for tests and the fixture generator:
 * the app never writes a TIFF, but a reader is only tested properly against files it did not make itself and
 * files built to the edge of what it claims to read.
 */
export function writeTiff({ width, height, bits = 16, data, littleEndian = true, rowsPerStrip = height }) {
  const bpp = bits / 8, img = width * height * bpp;
  const strips = Math.ceil(height / rowsPerStrip);
  const entries = 10;
  const ifdAt = 8 + img + (img % 2);
  const extra = ifdAt + 2 + entries * 12 + 4;
  const total = extra + strips * 8;
  const buf = new ArrayBuffer(total), dv = new DataView(buf), u8 = new Uint8Array(buf);
  const le = littleEndian;
  u8[0] = u8[1] = le ? 0x49 : 0x4d;
  dv.setUint16(2, 42, le); dv.setUint32(4, ifdAt, le);
  for (let i = 0; i < width * height; i++) { if (bits === 8) u8[8 + i] = data[i]; else dv.setUint16(8 + 2 * i, data[i], le); }
  dv.setUint16(ifdAt, entries, le);
  const stripBytes = (k) => Math.min(rowsPerStrip, height - k * rowsPerStrip) * width * bpp;
  const offTable = extra, cntTable = extra + strips * 4;
  const list = [[256, 3, 1, width], [257, 3, 1, height], [258, 3, 1, bits], [259, 3, 1, 1], [262, 3, 1, 1],
    [273, 4, strips, strips === 1 ? 8 : offTable], [277, 3, 1, 1], [278, 3, 1, rowsPerStrip], [279, 4, strips, strips === 1 ? stripBytes(0) : cntTable], [284, 3, 1, 1]];
  list.forEach(([tag, type, count, value], i) => {
    const at = ifdAt + 2 + 12 * i;
    dv.setUint16(at, tag, le); dv.setUint16(at + 2, type, le); dv.setUint32(at + 4, count, le);
    if (type === 3 && count === 1) dv.setUint16(at + 8, value, le); else dv.setUint32(at + 8, value, le);
  });
  dv.setUint32(ifdAt + 2 + entries * 12, 0, le);
  if (strips > 1) for (let k = 0; k < strips; k++) { dv.setUint32(offTable + 4 * k, 8 + k * rowsPerStrip * width * bpp, le); dv.setUint32(cntTable + 4 * k, stripBytes(k), le); }
  return u8;
}
