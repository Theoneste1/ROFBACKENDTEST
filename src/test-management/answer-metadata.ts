/**
 * Test Management (WS3, Phase 3) — blind marking of FILES: before an answer page reaches a marker, the metadata that can
 * identify a student is removed from the file itself (phone photos carry EXIF: GPS position — home or school —, the
 * owner's name, a device serial, comments; PDFs carry an author and an XMP packet). The stored original is never changed
 * (Administrators and Head Coaches see it as uploaded).
 *
 *   JPEG   APP1 (Exif, XMP), APP13 (IPTC), other application segments and comments are dropped (APP0 JFIF, APP2 ICC and
 *          APP14 Adobe stay: they describe colours, not people). No offsets to fix in a JPEG.
 *   PNG    tEXt, zTXt, iTXt, eXIf and tIME chunks are dropped.
 *   WebP   EXIF and XMP chunks are dropped; the RIFF size and the VP8X flags are corrected.
 *   GIF    comment extensions and XMP application extensions are dropped.
 *   HEIC   (and HEIF) identifying Exif values are blanked IN PLACE (same length, every offset stays valid): GPS, artist,
 *          copyright, descriptions, user comment, owner name, serial numbers, maker note; XMP packets are blanked.
 *   PDF    the document information strings (Author, Title, Subject, Keywords, Creator, Producer) and XMP packets are
 *          blanked IN PLACE (same length: the cross-reference table stays valid). Information inside compressed object
 *          streams is not reachable without rewriting the file (documented limitation).
 * A file that cannot be parsed is returned unchanged (it would not display either); every function is pure.
 */

const JPEG_KEEP_APP = new Set([0xe0, 0xe2, 0xee]);   // APP0 JFIF, APP2 ICC profile, APP14 Adobe

export function stripIdentifyingMetadata(data: Buffer, mimeType: string): Buffer {
  try {
    switch (mimeType) {
      case 'image/jpeg': return stripJpeg(data);
      case 'image/png': return stripPng(data);
      case 'image/webp': return stripWebp(data);
      case 'image/gif': return stripGif(data);
      case 'image/heic':
      case 'image/heif': return blankHeif(data);
      case 'application/pdf': return blankPdf(data);
      default: return data;
    }
  } catch {
    return data;
  }
}

function stripJpeg(b: Buffer): Buffer {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  const parts: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return b;
    const marker = b[i + 1];
    if (marker === 0xda) { parts.push(b.subarray(i)); return Buffer.concat(parts); }   // start of scan: image data follows
    if (marker === 0xd9) { parts.push(b.subarray(i)); return Buffer.concat(parts); }
    if (marker === 0xff) { i++; continue; }   // fill byte
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return b;
    const segment = b.subarray(i, i + 2 + len);
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const drop = (isApp && !JPEG_KEEP_APP.has(marker)) || marker === 0xfe;
    if (!drop) parts.push(segment);
    i += 2 + len;
  }
  return b;
}

const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function stripPng(b: Buffer): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (b.length < 8 || !b.subarray(0, 8).equals(sig)) return b;
  const parts: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > b.length) return b;
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  return b;
}

function stripWebp(b: Buffer): Buffer {
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return b;
  const chunks: Buffer[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const fourcc = b.toString('latin1', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    if (i + 8 + size > b.length) return b;
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      const chunk = Buffer.from(b.subarray(i, Math.min(end, b.length)));
      if (fourcc === 'VP8X' && size >= 1) chunk[8] &= ~0x0c;   // clear the EXIF (0x08) and XMP (0x04) flags
      chunks.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

function stripGif(b: Buffer): Buffer {
  const sig = b.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return b;
  const parts: Buffer[] = [];
  let i = 13;
  const flags = b[10];
  if (flags & 0x80) i += 3 * 2 ** ((flags & 0x07) + 1);   // global colour table
  parts.push(b.subarray(0, i));
  const subBlocksEnd = (from: number) => {
    let j = from;
    while (j < b.length && b[j] !== 0) j += b[j] + 1;
    return j + 1;
  };
  while (i < b.length) {
    const intro = b[i];
    if (intro === 0x3b) { parts.push(b.subarray(i, i + 1)); return Buffer.concat(parts); }
    if (intro === 0x21) {
      const label = b[i + 1];
      const end = subBlocksEnd(i + 2);
      const isComment = label === 0xfe;
      const isXmp = label === 0xff && b.toString('latin1', i + 3, i + 14) === 'XMP DataXMP';
      if (!isComment && !isXmp) parts.push(b.subarray(i, end));
      i = end;
      continue;
    }
    if (intro === 0x2c) {
      let j = i + 10;
      const f = b[i + 9];
      if (f & 0x80) j += 3 * 2 ** ((f & 0x07) + 1);   // local colour table
      const end = subBlocksEnd(j + 1);                 // LZW minimum code size, then the image data
      parts.push(b.subarray(i, end));
      i = end;
      continue;
    }
    return b;
  }
  return b;
}

/** Blank (same length) every XMP packet: `<x:xmpmeta …</x:xmpmeta>`. */
function blankXmp(s: string): string {
  return s.replace(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/g, (m) => ' '.repeat(m.length));
}

const TIFF_TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const IFD0_BLANK = new Set([0x010e, 0x013b, 0x8298, 0x9c9b, 0x9c9c, 0x9c9d, 0x9c9e, 0x9c9f, 0xa420]);
const EXIF_BLANK = new Set([0x9286, 0x927c, 0xa430, 0xa431, 0xa435, 0xa420]);

/** Zero, in place, the identifying values of the TIFF (Exif) structure starting at `t`; the GPS directory entirely. */
export function blankTiffIdentity(b: Buffer, t: number): void {
  const le = b.toString('latin1', t, t + 2) === 'II';
  if (!le && b.toString('latin1', t, t + 2) !== 'MM') return;
  const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const zero = (entry: number) => {
    const type = u16(entry + 2);
    const bytes = (TIFF_TYPE_SIZE[type] ?? 1) * u32(entry + 4);
    const at = bytes <= 4 ? entry + 8 : t + u32(entry + 8);
    if (at >= 0 && at + bytes <= b.length) b.fill(0, at, at + bytes);
  };
  const walk = (ifd: number, blank: (tag: number) => boolean, seen: Set<number>, depth: number) => {
    if (depth > 4 || seen.has(ifd) || t + ifd + 2 > b.length) return;
    seen.add(ifd);
    const n = u16(t + ifd);
    for (let k = 0; k < n; k++) {
      const e = t + ifd + 2 + k * 12;
      if (e + 12 > b.length) return;
      const tag = u16(e);
      if (tag === 0x8769) walk(u32(e + 8), (x) => EXIF_BLANK.has(x), seen, depth + 1);
      else if (tag === 0x8825) walk(u32(e + 8), () => true, seen, depth + 1);
      else if (blank(tag)) zero(e);
    }
  };
  walk(u32(t + 4), (x) => IFD0_BLANK.has(x), new Set(), 0);
}

function blankHeif(b: Buffer): Buffer {
  const s = b.toString('latin1');
  const out = Buffer.from(blankXmp(s), 'latin1');   // same length: every box offset stays valid
  for (let at = s.indexOf('Exif  '); at >= 0; at = s.indexOf('Exif  ', at + 6)) blankTiffIdentity(out, at + 6);
  return out;
}

const PDF_INFO_KEYS = /\/(Author|Title|Subject|Keywords|Creator|Producer)\s*(\(|<)/g;

function blankPdf(b: Buffer): Buffer {
  let s = b.toString('latin1');
  if (!s.startsWith('%PDF')) return b;
  const chars = s.split('');
  for (const m of s.matchAll(PDF_INFO_KEYS)) {
    let i = m.index! + m[0].length;
    if (m[2] === '<') {
      while (i < chars.length && chars[i] !== '>') { if (/[0-9A-Fa-f]/.test(chars[i])) chars[i] = '0'; i++; }
      continue;
    }
    let depth = 1;
    while (i < chars.length && depth > 0) {
      const c = chars[i];
      if (c === '\\') { chars[i] = ' '; if (i + 1 < chars.length) chars[i + 1] = ' '; i += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
      chars[i] = ' ';
      i++;
    }
  }
  s = blankXmp(chars.join(''));
  return Buffer.from(s, 'latin1');
}
