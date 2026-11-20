import { blankTiffIdentity, stripIdentifyingMetadata } from './answer-metadata.js';

/** A little-endian TIFF (Exif) block: IFD0 with Artist and a GPS pointer; a GPS IFD with one entry. */
function tiff(artist: string): Buffer {
  const b = Buffer.alloc(120);
  b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  b.writeUInt16LE(2, 8);                                                       // IFD0: 2 entries
  b.writeUInt16LE(0x013b, 10); b.writeUInt16LE(2, 12); b.writeUInt32LE(artist.length + 1, 14); b.writeUInt32LE(60, 18);   // Artist → offset 60
  b.writeUInt16LE(0x8825, 22); b.writeUInt16LE(4, 24); b.writeUInt32LE(1, 26); b.writeUInt32LE(40, 30);                   // GPS IFD at 40
  b.writeUInt32LE(0, 34);
  b.writeUInt16LE(1, 40);                                                      // GPS IFD: 1 entry (latitude ref, inline)
  b.writeUInt16LE(0x0001, 42); b.writeUInt16LE(2, 44); b.writeUInt32LE(2, 46); b.write('S\0', 50, 'latin1');
  b.write(`${artist}\0`, 60, 'latin1');
  return b;
}

function jpeg(...segments: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9])]);
}
function seg(marker: number, payload: Buffer): Buffer {
  const h = Buffer.from([0xff, marker, 0, 0]);
  h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}
function pngChunk(type: string, data: Buffer): Buffer {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
  return b;
}

describe('blind marking of files: identifying metadata removed before a marker downloads a page', () => {
  it('JPEG: Exif (APP1), IPTC (APP13) and comments go; JFIF, ICC and the image data stay', () => {
    const jfif = seg(0xe0, Buffer.from('JFIF\0\x01\x01', 'latin1'));
    const exif = seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff('Aline Uwase')]));
    const iptc = seg(0xed, Buffer.from('Photoshop 3.0 Aline', 'latin1'));
    const icc = seg(0xe2, Buffer.from('ICC_PROFILE', 'latin1'));
    const com = seg(0xfe, Buffer.from('Taken at Test School', 'latin1'));
    const out = stripIdentifyingMetadata(jpeg(jfif, exif, iptc, icc, com), 'image/jpeg');
    const s = out.toString('latin1');
    expect(s).not.toMatch(/Aline|Test School|Exif/);
    expect(out.equals(jpeg(jfif, icc))).toBe(true);
  });

  it('PNG: text, iTXt, eXIf and time chunks go; the image chunks stay', () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = pngChunk('IHDR', Buffer.alloc(13));
    const idat = pngChunk('IDAT', Buffer.from('pixels'));
    const iend = pngChunk('IEND', Buffer.alloc(0));
    const src = Buffer.concat([sig, ihdr, pngChunk('tEXt', Buffer.from('Author\0Aline')), pngChunk('eXIf', tiff('Aline')), idat, pngChunk('iTXt', Buffer.from('Comment Aline')), iend]);
    const out = stripIdentifyingMetadata(src, 'image/png');
    expect(out.equals(Buffer.concat([sig, ihdr, idat, iend]))).toBe(true);
  });

  it('WebP: EXIF and XMP chunks go; the RIFF size and the VP8X flags are corrected', () => {
    const chunk = (cc: string, data: Buffer) => { const h = Buffer.alloc(8); h.write(cc, 0, 'latin1'); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
    const vp8x = chunk('VP8X', Buffer.from([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    const body = Buffer.concat([vp8x, chunk('VP8 ', Buffer.from('image')), chunk('EXIF', tiff('Aline')), chunk('XMP ', Buffer.from('<x:xmpmeta>Aline</x:xmpmeta>'))]);
    const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(4 + body.length, 4); head.write('WEBP', 8, 'latin1');
    const out = stripIdentifyingMetadata(Buffer.concat([head, body]), 'image/webp');
    expect(out.toString('latin1')).not.toMatch(/Aline|EXIF|XMP /);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out[20] & 0x0c).toBe(0);
  });

  it('GIF: comment and XMP extensions go; the image stays', () => {
    const head = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 0, 1, 0, 0x80, 0, 0]), Buffer.alloc(6)]);   // 2-colour global table
    const comment = Buffer.concat([Buffer.from([0x21, 0xfe, 5]), Buffer.from('Aline'), Buffer.from([0])]);
    const image = Buffer.concat([Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0])]);
    const out = stripIdentifyingMetadata(Buffer.concat([head, comment, image, Buffer.from([0x3b])]), 'image/gif');
    expect(out.equals(Buffer.concat([head, image, Buffer.from([0x3b])]))).toBe(true);
  });

  it('HEIC: Exif values (artist, the whole GPS directory) and XMP are blanked in place — same length', () => {
    const src = Buffer.concat([Buffer.from('....ftypheic....Exif\0\0', 'latin1'), tiff('Aline Uwase'), Buffer.from('<x:xmpmeta>Aline</x:xmpmeta>', 'latin1')]);
    const out = stripIdentifyingMetadata(src, 'image/heic');
    expect(out.length).toBe(src.length);
    expect(out.toString('latin1')).not.toMatch(/Aline/);
    expect(out.toString('latin1')).not.toContain('S\0');   // the GPS latitude reference
  });

  it('PDF: Author, Title, Creator … and XMP are blanked in place (same length, offsets valid)', () => {
    const src = Buffer.from('%PDF-1.4\n1 0 obj<</Author (Aline \\(S2\\) Uwase) /Title <416C696E65> /Producer (Scanner)>>endobj\n<x:xmpmeta>Aline</x:xmpmeta>\n%%EOF', 'latin1');
    const out = stripIdentifyingMetadata(src, 'application/pdf');
    expect(out.length).toBe(src.length);
    const s = out.toString('latin1');
    expect(s).not.toMatch(/Aline|Uwase|Scanner|416C/);
    expect(s).toContain('/Author (');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
  });

  it('other types and unreadable files are returned unchanged', () => {
    const odd = Buffer.from('not an image');
    expect(stripIdentifyingMetadata(odd, 'image/jpeg')).toBe(odd);
    expect(stripIdentifyingMetadata(odd, 'text/plain')).toBe(odd);
    const t = tiff('Bobby Kamali');
    blankTiffIdentity(t, 0);
    expect(t.toString('latin1')).not.toContain('Bobby');
  });
});
