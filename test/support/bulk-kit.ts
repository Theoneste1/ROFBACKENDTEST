/** Shared helpers for the e2e specs of the bulk record types (test/bulk-*.e2e-spec.ts). */
import { BulkOperationsWorker } from '../../src/bulk/bulk-operations.worker.js';
import { bearer, type TestContext } from '../helpers.js';

export function bulkKit(ctx: TestContext, entityType: string) {
  const G = '/api/v1/admin/bulk';
  const http = () => ctx.http();
  let n = 0;
  const key = () => `${entityType.toLowerCase()}-key-${++n}-${Date.now()}`;
  const worker = () => ctx.app.get(BulkOperationsWorker);
  return {
    G,
    key,
    preview: (token: string, body: object) => http().post(`${G}/${entityType}/preview`).set(bearer(token)).send(body),
    execute: (token: string, body: object) => http().post(`${G}/${entityType}`).set(bearer(token)).send(body),
    /** The execute body that confirms a preview response. */
    confirmBody: (pv: { body: Record<string, any> }, extra: object = {}) => ({
      action: pv.body.action, selection: pv.body.selection, selectionToken: pv.body.selectionToken, expectedTotal: pv.body.total,
      confirm: true, idempotencyKey: key(), ...extra,
    }),
    /** Runs the worker until no item is pending. */
    drain: async () => { while ((await worker().processBatch()) > 0) { /* next batch */ } },
    progress: async (token: string, id: string) => (await http().get(`${G}/operations/${id}`).set(bearer(token)).expect(200)).body,
    /** entityId → [outcome, code] of every item. */
    outcomes: async (token: string, id: string) => {
      const r = await http().get(`${G}/operations/${id}/items`).query({ limit: 100 }).set(bearer(token)).expect(200);
      return Object.fromEntries(r.body.data.map((i: any) => [i.entityId, [i.outcome, i.code]])) as Record<string, [string, string | null]>;
    },
    items: async (token: string, id: string) => (await http().get(`${G}/operations/${id}/items`).query({ limit: 100 }).set(bearer(token)).expect(200)).body.data as any[],
    code: async (req: PromiseLike<{ status: number; body?: any }>) => { const r = await req; return [r.status, r.body?.code ?? null]; },
  };
}
