/**
 * Bulk user operations: since 2026-11-19 the engine is generic (src/bulk/bulk-operations.service.ts) and the USER
 * record type is UserBulkHandler. Re-exported here so existing imports keep working.
 */
export { auditSelection, BulkOperationsService, refreshCounts } from '../../bulk/bulk-operations.service.js';
export { EXPORT_HEADERS } from './user-bulk.handler.js';
