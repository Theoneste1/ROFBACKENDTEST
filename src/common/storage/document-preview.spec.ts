import { describe, expect, it } from 'vitest';

import { MIME } from './file-rules.js';
import { OFFICE_TYPES, OneAtATime, parseRange, previewKey } from './document-preview.js';

describe('document previews (owner 2026-11-27)', () => {
  it('Word and PowerPoint files are previewed as PDF; PDFs and images are not converted', () => {
    expect([...OFFICE_TYPES].sort()).toEqual([MIME.DOC, MIME.PPT, MIME.DOCX, MIME.PPTX].sort());
    expect(OFFICE_TYPES.has(MIME.PDF)).toBe(false);
    expect(previewKey('resources/abc.docx')).toBe('previews/resources/abc.docx.pdf');
  });

  it('byte ranges: start-end, open end, suffix; outside the file is unsatisfiable; malformed or multiple ranges ignored', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=990-5000', 1000)).toEqual({ start: 990, end: 999 });
    expect(parseRange('bytes=1000-', 1000)).toBe('UNSATISFIABLE');
    expect(parseRange('bytes=-0', 1000)).toBe('UNSATISFIABLE');
    expect(parseRange('bytes=50-10', 1000)).toBe('UNSATISFIABLE');
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeNull();
    expect(parseRange('items=0-1', 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
  });

  it('conversions run one at a time, in order, and a failure does not stop the next', async () => {
    const q = new OneAtATime();
    const log: string[] = [];
    let running = 0;
    const task = (name: string, fail = false) => async () => {
      running++;
      expect(running).toBe(1);
      await new Promise((r) => setTimeout(r, 5));
      log.push(name);
      running--;
      if (fail) throw new Error(name);
      return name;
    };
    const results = await Promise.allSettled([q.run(task('a')), q.run(task('b', true)), q.run(task('c'))]);
    expect(log).toEqual(['a', 'b', 'c']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
