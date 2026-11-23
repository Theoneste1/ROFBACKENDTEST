/** The record types the bulk engine knows (docs/operations/bulk-operations.md, "Adding a record type"). */
import { HttpStatus, Injectable } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import type { BulkEntityHandler } from './bulk-handler.js';

@Injectable()
export class BulkRegistry {
  private readonly handlers = new Map<string, BulkEntityHandler>();

  /** Called by each handler's module on start. A type is registered once. */
  register(handler: BulkEntityHandler): void {
    if (!/^[A-Z][A-Z_]*$/.test(handler.entityType)) throw new Error(`Invalid bulk entity type ${handler.entityType}`);
    const existing = this.handlers.get(handler.entityType);
    if (existing && existing !== handler) throw new Error(`Bulk entity type ${handler.entityType} is already registered`);
    this.handlers.set(handler.entityType, handler);
  }

  /** Test support: removes a type registered by a test. */
  unregister(entityType: string): void {
    this.handlers.delete(entityType);
  }

  get(entityType: string): BulkEntityHandler {
    const h = this.handlers.get(entityType);
    if (!h) throw new AppError(HttpStatus.NOT_FOUND, 'BULK_ENTITY_UNKNOWN', 'This kind of record cannot be changed in bulk. Refresh the page and try again.');
    return h;
  }

  action(handler: BulkEntityHandler, action: string) {
    const meta = Object.hasOwn(handler.actions, action) ? handler.actions[action] : undefined;
    if (!meta) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'BULK_ACTION_UNKNOWN', 'This action is not available for these records in bulk. Refresh the page and try again.',
        { actions: Object.keys(handler.actions) });
    }
    return meta;
  }

  all(): BulkEntityHandler[] {
    return [...this.handlers.values()].sort((a, b) => a.entityType.localeCompare(b.entityType));
  }
}
