import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';

import { LocalStorageDriver } from './local-storage.driver.js';
import { S3StorageDriver } from './s3-storage.driver.js';
import { STORAGE_DRIVER } from './storage-driver.js';
import { StorageService } from './storage.service.js';

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_DRIVER,
      inject:  [ConfigService],
      useFactory: (config: ConfigService) => {
        if (config.get('STORAGE_DRIVER') === 's3') {
          return new S3StorageDriver({
            bucket:          config.getOrThrow<string>('S3_BUCKET'),
            region:          config.get<string>('S3_REGION'),
            endpoint:        config.get<string>('S3_ENDPOINT'),
            accessKeyId:     config.get<string>('S3_ACCESS_KEY_ID'),
            secretAccessKey: config.get<string>('S3_SECRET_ACCESS_KEY'),
            forcePathStyle:  config.get<boolean>('S3_FORCE_PATH_STYLE'),
          });
        }
        return new LocalStorageDriver(
          config.get<string>('UPLOAD_DIR') ?? join(process.cwd(), 'storage'),
        );
      },
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
