import { EventEmitter } from 'node:events';
import {
  csvBatchSize, csvFromRows, csvText, keysetBatches, mapBatches, offsetBatches, toCsv, type BatchPage, type CsvExport,
} from './csv.js';
import { sendCsvExport } from './csv-stream.js';

const BOM = '﻿';
const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(6, '0')}`, n: i }));

/** A fake Prisma findMany over `rows` in order, honouring cursor/skip/take like Prisma does. */
function fakeFind<T extends { id: string }>(rows: T[]) {
  const calls: BatchPage[] = [];
  const find = async (page: BatchPage) => {
    calls.push(page);
    let start = 0;
    if (page.cursor) start = rows.findIndex((r) => r.id === page.cursor!.id) + (page.skip ?? 0);
    else start = page.skip ?? 0;
    return rows.slice(start, start + page.take);
  };
  return { find, calls };
}

const collect = async <T>(it: AsyncIterable<T[]>) => { const out: T[][] = []; for await (const b of it) out.push(b); return out; };

describe('streamed CSV exports (M5: no 50,000-row limit)', () => {
  it('keyset paging reads every row exactly once, in order, beyond the old 50,000 cap', async () => {
    const rows = ids(120_005);
    const { find, calls } = fakeFind(rows);
    const batches = await collect(keysetBatches(find, 2_000));
    expect(batches.flat().map((r) => r.n)).toEqual(rows.map((r) => r.n));
    expect(batches).toHaveLength(61);
    expect(calls[0]).toEqual({ take: 2_000 });
    expect(calls[1]).toEqual({ take: 2_000, cursor: { id: rows[1_999].id }, skip: 1 });
  });

  it('keyset: an exact multiple of the batch size ends with one empty read; an empty result yields nothing', async () => {
    const { find, calls } = fakeFind(ids(4));
    expect((await collect(keysetBatches(find, 2))).map((b) => b.length)).toEqual([2, 2]);
    expect(calls).toHaveLength(3);
    expect(await collect(keysetBatches(fakeFind([]).find, 2))).toEqual([]);
  });

  it('offset paging (relation orders) reads every row once', async () => {
    const rows = ids(7);
    const { find, calls } = fakeFind(rows);
    expect((await collect(offsetBatches(find, 3))).flat()).toEqual(rows);
    expect(calls.map((c) => c.skip)).toEqual([0, 3, 6]);
  });

  it('the batch size defaults to 2,000 and only a positive integer overrides it', () => {
    const old = process.env.REPORT_CSV_BATCH_SIZE;
    try {
      delete process.env.REPORT_CSV_BATCH_SIZE;
      expect(csvBatchSize()).toBe(2_000);
      process.env.REPORT_CSV_BATCH_SIZE = '2';
      expect(csvBatchSize()).toBe(2);
      for (const bad of ['0', '-5', '1.5', 'abc']) { process.env.REPORT_CSV_BATCH_SIZE = bad; expect(csvBatchSize()).toBe(2_000); }
    } finally {
      if (old === undefined) delete process.env.REPORT_CSV_BATCH_SIZE; else process.env.REPORT_CSV_BATCH_SIZE = old;
    }
  });

  it('the streamed text is byte-identical to the previous toCsv output (BOM, quoting, formula guard, CRLF)', async () => {
    const data: Array<Array<string | number | null>> = [['=SUM(A1)', 1], ['a,b', null], ['say "hi"', -5]];
    const exp: CsvExport = { headers: ['x', 'y'], batches: mapBatches(offsetBatches(async ({ skip = 0, take }) => data.slice(skip, skip + take), 2), (b) => b) };
    expect(await csvText(exp)).toBe(toCsv(['x', 'y'], data));
    expect(await csvText(csvFromRows(['h'], []))).toBe(`${BOM}h\r\n`);
  });
});

/** A minimal HTTP response: records writes; `write` returns false once to exercise backpressure. */
function fakeRes({ pressureOnce = false } = {}) {
  const ev = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const out = { chunks: [] as string[], headers: {} as Record<string, string>, status: 0, ended: false, destroyedWith: undefined as unknown };
  let pressure = pressureOnce;
  Object.assign(ev, {
    destroyed: false, writableEnded: false,
    status(code: number) { out.status = code; return ev; },
    setHeader(k: string, v: string) { out.headers[k] = v; },
    write(chunk: string) {
      out.chunks.push(chunk);
      if (pressure) { pressure = false; setTimeout(() => ev.emit('drain'), 5); return false; }
      return true;
    },
    end() { out.ended = true; ev.writableEnded = true; },
    destroy(err?: unknown) { out.destroyedWith = err; ev.destroyed = true; ev.emit('close'); },
  });
  return { res: ev as never, out, ev };
}

const exportOf = (batches: AsyncIterable<Array<Array<string | number>>>): CsvExport => ({ headers: ['a', 'b'], batches });

describe('sendCsvExport', () => {
  it('sends headers, BOM + header line and every batch, waiting for drain under backpressure', async () => {
    const { res, out } = fakeRes({ pressureOnce: true });
    await sendCsvExport(res, 'x.csv', exportOf((async function* () { yield [[1, 2]]; yield [[3, 4], [5, 6]]; })()));
    expect(out.status).toBe(200);
    expect(out.headers['Content-Disposition']).toBe('attachment; filename="x.csv"');
    expect(out.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(out.chunks.join('')).toBe(`${BOM}a,b\r\n1,2\r\n3,4\r\n5,6\r\n`);
    expect(out.ended).toBe(true);
  });

  it('a failure before the first byte is thrown (an ordinary error response) and nothing is written', async () => {
    const { res, out } = fakeRes();
    await expect(sendCsvExport(res, 'x.csv', exportOf((async function* () { throw new Error('db down'); })())))
      .rejects.toThrow('db down');
    expect(out.chunks).toEqual([]);
    expect(out.status).toBe(0);
  });

  it('a failure after the download started aborts the connection — never a silently truncated file', async () => {
    const { res, out } = fakeRes();
    await sendCsvExport(res, 'x.csv', exportOf((async function* () { yield [[1, 2]]; throw new Error('lost connection'); })()));
    expect(out.ended).toBe(false);
    expect((out.destroyedWith as Error).message).toBe('lost connection');
  });

  it('stops reading the database when the client has gone away', async () => {
    const { res, ev } = fakeRes();
    let reads = 0;
    const batches = (async function* () {
      for (let i = 0; i < 100; i++) { reads++; if (i === 1) (ev as never as { destroyed: boolean }).destroyed = true; yield [[i, i]]; }
    })();
    await sendCsvExport(res, 'x.csv', exportOf(batches));
    expect(reads).toBeLessThan(5);
  });
});
