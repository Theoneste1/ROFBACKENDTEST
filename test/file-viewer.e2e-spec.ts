/**
 * Opening files inside the LMS (owner 2026-11-27, item 9), end to end:
 *  - every file route answers HTTP Range requests (206 + Content-Range; 416 outside the file), so the PDF viewer reads a
 *    large document page by page instead of loading it whole; the permission checks are the route's own, unchanged;
 *  - ?preview=pdf on a Word / PowerPoint file: 409 PREVIEW_NOT_AVAILABLE while DOCUMENT_PREVIEW_ENABLED is off; on, the
 *    document is converted once (LibreOffice in production; a stand-in here), cached, and answered as an inline PDF;
 *    a failed conversion answers 422 PREVIEW_FAILED (the file can still be downloaded);
 *  - someone without access to the file gets no preview either.
 */
import JSZip from 'jszip';

import { StorageService } from '../src/common/storage/storage.service.js';
import { PDF, bearer, createTestApp, login, type TestContext } from './helpers.js';

async function docx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Problem set 1</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('Opening files inside the LMS (e2e)', () => {
  let ctx: TestContext;
  let mentor: string;
  let student: string;
  let pdfUrl: string;
  let docUrl: string;
  const FAKE_PDF = Buffer.from('%PDF-1.4\n% converted preview\n%%EOF\n');

  beforeAll(async () => {
    delete process.env.DOCUMENT_PREVIEW_ENABLED;
    ctx = await createTestApp();
    mentor = await login(ctx, 'mentor.j');
    student = await login(ctx, 'student.j');
    const base = `/api/v1/courses/${ctx.ids.algebra}/resources`;
    const make = async (title: string, file: Buffer, name: string) => {
      const r = await ctx.http().post(base).set(bearer(mentor)).field('divisionId', ctx.ids.junior).field('type', 'NOTE').field('title', title)
        .attach('file', file, name).expect(201);
      await ctx.http().patch(`${base}/${r.body.id}/publish`).set(bearer(mentor)).expect(200);
      return `${base}/${r.body.id}/file`;
    };
    pdfUrl = await make('Viewer PDF', PDF, 'notes.pdf');
    docUrl = await make('Viewer Word', await docx(), 'problems.docx');
  });
  afterAll(async () => {
    delete process.env.DOCUMENT_PREVIEW_ENABLED;
    await ctx?.app.close();
  });

  it('a whole file: 200 and Accept-Ranges; a range: 206 with exactly those bytes; outside the file: 416', async () => {
    const whole = await ctx.http().get(pdfUrl).set(bearer(student)).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(whole.status).toBe(200);
    expect(whole.headers['accept-ranges']).toBe('bytes');
    const size = (whole.body as Buffer).length;
    expect(size).toBe(PDF.length);
    const part = await ctx.http().get(pdfUrl).set(bearer(student)).set('Range', 'bytes=0-4').buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-4/${size}`);
    expect((part.body as Buffer).toString()).toBe('%PDF-');
    const tail = await ctx.http().get(pdfUrl).set(bearer(student)).set('Range', 'bytes=-3');
    expect([tail.status, tail.headers['content-range']]).toEqual([206, `bytes ${size - 3}-${size - 1}/${size}`]);
    const beyond = await ctx.http().get(pdfUrl).set(bearer(student)).set('Range', `bytes=${size}-`);
    expect([beyond.status, beyond.headers['content-range']]).toEqual([416, `bytes */${size}`]);
  });

  it('a Word file while previews are off: 409 PREVIEW_NOT_AVAILABLE; it can still be downloaded', async () => {
    const r = await ctx.http().get(docUrl).query({ preview: 'pdf' }).set(bearer(student));
    expect([r.status, r.body.code]).toEqual([409, 'PREVIEW_NOT_AVAILABLE']);
    const dl = await ctx.http().get(docUrl).query({ download: 'true' }).set(bearer(student));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('wordprocessingml');
  });

  it('previews on: converted once, cached, answered inline as PDF (ranges too); a PDF is never converted', async () => {
    process.env.DOCUMENT_PREVIEW_ENABLED = 'true';
    const storage = ctx.app.get(StorageService);
    let conversions = 0;
    storage.converter = async (data, mime) => {
      conversions++;
      expect(mime).toContain('wordprocessingml');
      expect(data.subarray(0, 2).toString()).toBe('PK');
      return FAKE_PDF;
    };
    const first = await ctx.http().get(docUrl).query({ preview: 'pdf' }).set(bearer(student));
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('application/pdf');
    expect(first.headers['content-disposition']).toMatch(/^inline;.*problems\.pdf/);
    const again = await ctx.http().get(docUrl).query({ preview: 'pdf' }).set(bearer(mentor)).set('Range', 'bytes=0-4');
    expect([again.status, again.headers['content-range']]).toEqual([206, `bytes 0-4/${FAKE_PDF.length}`]);
    expect(conversions).toBe(1);   // the cached preview is reused
    const pdf = await ctx.http().get(pdfUrl).query({ preview: 'pdf' }).set(bearer(student));
    expect([pdf.status, pdf.headers['content-type']]).toEqual([200, 'application/pdf']);
    expect(conversions).toBe(1);
  });

  it('a failed conversion: 422 PREVIEW_FAILED; nothing cached; a later success is served', async () => {
    const storage = ctx.app.get(StorageService);
    const base = `/api/v1/courses/${ctx.ids.algebra}/resources`;
    const r = await ctx.http().post(base).set(bearer(mentor)).field('divisionId', ctx.ids.junior).field('type', 'NOTE').field('title', 'Broken Word')
      .attach('file', await docx(), 'broken.docx').expect(201);
    await ctx.http().patch(`${base}/${r.body.id}/publish`).set(bearer(mentor)).expect(200);
    storage.converter = async () => { throw new Error('cannot read'); };
    const failed = await ctx.http().get(`${base}/${r.body.id}/file`).query({ preview: 'pdf' }).set(bearer(student));
    expect([failed.status, failed.body.code]).toEqual([422, 'PREVIEW_FAILED']);
    storage.converter = async () => FAKE_PDF;
    expect((await ctx.http().get(`${base}/${r.body.id}/file`).query({ preview: 'pdf' }).set(bearer(student))).status).toBe(200);
  });

  it('no access to the file, no preview: the route checks the person first', async () => {
    const senior = await login(ctx, 'student.s');   // another division: the resource is not theirs
    const r = await ctx.http().get(docUrl).query({ preview: 'pdf' }).set(bearer(senior));
    expect([403, 404]).toContain(r.status);
    expect((await ctx.http().get(docUrl).query({ preview: 'pdf' })).status).toBe(401);
  });
});
