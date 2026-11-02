import { createHash } from 'crypto';
import { StorageService, contentDisposition, sanitizeOriginalName } from './storage.service.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(256)]);

function upload(buffer: Buffer, originalname = 'work.pdf') {
  return { buffer, originalname, size: buffer.length, mimetype: 'application/pdf' } as Express.Multer.File;
}

function makeService() {
  const driver = {
    name:      'mock',
    put:       vi.fn().mockResolvedValue(undefined),
    getStream: vi.fn(),
    delete:    vi.fn(),
    ping:      vi.fn(),
  };
  const prisma = {
    fileObject: { create: vi.fn((args: { data: unknown }) => Promise.resolve({ id: 'f1', ...(args.data as object) })) },
  };
  const config = { get: vi.fn() };
  const service = new StorageService(driver as any, prisma as any, config as any);
  return { service, driver, prisma };
}

describe('sanitizeOriginalName', () => {
  it('keeps a normal name', () => {
    expect(sanitizeOriginalName('Homework 1.pdf', 'pdf')).toBe('Homework 1.pdf');
  });

  it('strips directory components (both separators)', () => {
    expect(sanitizeOriginalName('../../etc/passwd', 'txt')).toBe('passwd');
    expect(sanitizeOriginalName('C:\\Users\\me\\essay.docx', 'docx')).toBe('essay.docx');
  });

  it('removes control characters and double quotes', () => {
    expect(sanitizeOriginalName('a\u0000b\r\n"c".pdf', 'pdf')).toBe('abc.pdf');
  });

  it('truncates to 200 characters', () => {
    expect(sanitizeOriginalName('x'.repeat(300), 'pdf')).toHaveLength(200);
  });

  it('falls back to "file.<ext>" for an empty name', () => {
    expect(sanitizeOriginalName('', 'pdf')).toBe('file.pdf');
  });

  it('falls back to file.<ext> when nothing usable remains', () => {
    expect(sanitizeOriginalName('dir/', 'png')).toBe('file.png');
    expect(sanitizeOriginalName('   ', 'txt')).toBe('file.txt');
  });
});

describe('contentDisposition', () => {
  it('builds an attachment header with ASCII fallback and RFC 5987 name', () => {
    expect(contentDisposition('report.pdf', false))
      .toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  });

  it('builds an inline header', () => {
    expect(contentDisposition('a.png', true).startsWith('inline;')).toBe(true);
  });

  it('replaces non-ASCII, quotes and backslashes in the fallback', () => {
    expect(contentDisposition('Émilie "x"\\y.pdf', false))
      .toBe(`attachment; filename="_milie _x__y.pdf"; filename*=UTF-8''%C3%89milie%20%22x%22%5Cy.pdf`);
  });
});

describe('StorageService.store', () => {
  it('accepts a PDF submission, stores it under a random key and records metadata', async () => {
    const { service, driver, prisma } = makeService();

    await service.store(upload(PDF, 'my work.pdf'), 'SUBMISSION', 'u1');

    expect(driver.put).toHaveBeenCalledOnce();
    const [key, data, mime] = driver.put.mock.calls[0];
    expect(key).toMatch(/^submissions\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/);
    expect(data).toBe(PDF);
    expect(mime).toBe('application/pdf');

    expect(prisma.fileObject.create).toHaveBeenCalledWith({
      data: {
        storageKey:   key,
        purpose:      'SUBMISSION',
        originalName: 'my work.pdf',
        mimeType:     'application/pdf',
        size:         PDF.length,
        sha256:       createHash('sha256').update(PDF).digest('hex'),
        uploadedById: 'u1',
      },
    });
  });

  it('detects the type from bytes, not the claimed name', async () => {
    const { service, driver } = makeService();
    await service.store(upload(Buffer.from('just some notes\n'), 'notes.pdf'), 'SUBMISSION', 'u1');
    expect(driver.put.mock.calls[0][2]).toBe('text/plain');
    expect(driver.put.mock.calls[0][0]).toMatch(/\.txt$/);
  });

  it('rejects an executable disguised as a PDF with FILE_TYPE_NOT_ALLOWED', async () => {
    const { service, driver, prisma } = makeService();
    await expect(service.store(upload(EXE, 'work.pdf'), 'SUBMISSION', 'u1'))
      .rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED', status: 415 });
    expect(driver.put).not.toHaveBeenCalled();
    expect(prisma.fileObject.create).not.toHaveBeenCalled();
  });

  it('rejects an empty buffer with EMPTY_FILE', async () => {
    const { service, driver } = makeService();
    await expect(service.store(upload(Buffer.alloc(0)), 'SUBMISSION', 'u1'))
      .rejects.toMatchObject({ code: 'EMPTY_FILE', status: 400 });
    expect(driver.put).not.toHaveBeenCalled();
  });

  it('rejects a file over the purpose limit with FILE_TOO_LARGE', async () => {
    const { service, driver } = makeService();
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
    await expect(service.store(upload(big, 'big.txt'), 'FEEDBACK', 'u1'))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE', status: 413 });
    expect(driver.put).not.toHaveBeenCalled();
  });
});
