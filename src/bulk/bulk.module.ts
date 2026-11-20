/**
 * The bulk operations engine (docs/operations/bulk-operations.md): the registry of record types, the engine, the
 * worker and the generic routes. Global, so a record type's module registers its handler with BulkRegistry without
 * importing this module (USER: UsersModule → UserBulkHandler).
 */
import { Global, Module } from '@nestjs/common';

import { BulkController } from './bulk.controller.js';
import { BulkOperationsService } from './bulk-operations.service.js';
import { BulkOperationsWorker } from './bulk-operations.worker.js';
import { BulkRegistry } from './bulk-registry.js';

@Global()
@Module({
  controllers: [BulkController],
  providers:   [BulkRegistry, BulkOperationsService, BulkOperationsWorker],
  exports:     [BulkRegistry, BulkOperationsService],
})
export class BulkModule {}
