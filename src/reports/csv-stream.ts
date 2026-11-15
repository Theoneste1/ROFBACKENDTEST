/**
 * Sends a streamed CSV export (csv.ts) over HTTP.
 *
 * - The first batch is read BEFORE anything is sent: a failure there (bad filter, database down)
 *   is an ordinary error response.
 * - Then the header and every batch are written with backpressure (memory stays flat).
 * - A failure AFTER the first bytes cannot change the status any more: the connection is aborted,
 *   so the browser reports a failed download instead of saving a silently truncated file.
 * - If the client goes away, reading stops (no queries for nobody).
 */
import { Logger } from '@nestjs/common';
import { once } from 'node:events';
import type { Response } from 'express';

import { CSV_BOM, csvLine, type CsvExport } from './csv.js';

const logger = new Logger('CsvExport');

type Sink = Pick<Response, 'setHeader' | 'status' | 'write' | 'end' | 'destroy' | 'once'> & { destroyed: boolean; writableEnded: boolean };

async function write(res: Sink, chunk: string): Promise<boolean> {
  if (res.destroyed) return false;
  if (!res.write(chunk)) {
    await Promise.race([once(res as never, 'drain'), once(res as never, 'close')]);
  }
  return !res.destroyed;
}

export async function sendCsvExport(res: Sink, filename: string, exp: CsvExport): Promise<void> {
  const rows = exp.batches[Symbol.asyncIterator]();
  const first = await rows.next();   // throws → normal error response (nothing sent yet)

  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!(await write(res, CSV_BOM + csvLine(exp.headers)))) return void (await rows.return?.());
    let next = first;
    while (!next.done) {
      if (!(await write(res, next.value.map(csvLine).join('')))) return void (await rows.return?.());
      next = await rows.next();
    }
    res.end();
  } catch (err) {
    logger.error(`export ${filename} failed after the response started; connection aborted: ${(err as Error).message}`);
    await rows.return?.().catch(() => undefined);
    res.destroy(err as Error);
  }
}
