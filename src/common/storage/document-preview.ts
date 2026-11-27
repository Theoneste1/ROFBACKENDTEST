/**
 * Word and PowerPoint previews (owner 2026-11-27, item 9): a document is converted to PDF on the server the first time
 * someone opens it, cached next to the original (key `previews/<storageKey>.pdf`; files never leave our servers), and
 * shown in the LMS's PDF viewer. Switched on by DOCUMENT_PREVIEW_ENABLED=true (needs LibreOffice in the image and enough
 * memory — Render "Standard" or larger; off by default). One conversion at a time, with a time limit.
 */
import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { MIME } from './file-rules.js';

/** The formats converted to PDF for a preview. */
export const OFFICE_TYPES: ReadonlySet<string> = new Set([MIME.DOCX, MIME.DOC, MIME.PPTX, MIME.PPT]);

const EXTENSION: Record<string, string> = {
  [MIME.DOCX]: 'docx', [MIME.DOC]: 'doc', [MIME.PPTX]: 'pptx', [MIME.PPT]: 'ppt',
};

/** Where a document's cached PDF preview is kept. */
export const previewKey = (storageKey: string) => `previews/${storageKey}.pdf`;

/** Converts one document (bytes + MIME type) to PDF bytes. */
export type DocumentConverter = (data: Buffer, mimeType: string) => Promise<Buffer>;

/**
 * LibreOffice, headless: `soffice --headless --convert-to pdf --outdir <dir> <file>` in a private temporary folder
 * (its own profile, so no state is shared between runs), killed after `timeoutMs`.
 */
export function libreOfficeConverter(command = 'soffice', timeoutMs = 120_000): DocumentConverter {
  return async (data, mimeType) => {
    const dir = await mkdtemp(join(tmpdir(), 'rof-preview-'));
    try {
      const source = join(dir, `document.${EXTENSION[mimeType] ?? 'bin'}`);
      await writeFile(source, data);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, [
          `-env:UserInstallation=file:///${join(dir, 'profile').replace(/\\/g, '/')}`,
          '--headless', '--norestore', '--nologo', '--convert-to', 'pdf', '--outdir', dir, source,
        ], { stdio: 'ignore' });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('The conversion took too long.')); }, timeoutMs);
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`The converter stopped (code ${code}).`)); });
      });
      return await readFile(join(dir, 'document.pdf'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** Runs one task at a time (conversions are memory-heavy); later callers wait their turn. */
export class OneAtATime {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** "bytes=START-END" / "bytes=START-" / "bytes=-SUFFIX" for a file of `size` bytes; null: ignore (send it whole). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'UNSATISFIABLE' | null {
  if (!header || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;   // malformed or several ranges: the whole file
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'UNSATISFIABLE';
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'UNSATISFIABLE';
  return { start, end };
}
