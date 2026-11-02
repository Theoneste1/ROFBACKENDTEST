import { NotFoundException } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'stream';

import type { StorageDriver } from './storage-driver.js';

export interface S3DriverOptions {
  bucket:          string;
  region?:         string;
  endpoint?:       string;
  accessKeyId?:    string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

/**
 * Stores files in any S3-compatible object store
 * (AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces, …).
 * Required when running more than one API instance.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = 's3';
  private readonly client: S3Client;

  constructor(private readonly opts: S3DriverOptions) {
    this.client = new S3Client({
      region:         opts.region ?? 'auto',
      endpoint:       opts.endpoint,
      forcePathStyle: opts.forcePathStyle,
      credentials:
        opts.accessKeyId && opts.secretAccessKey
          ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
          : undefined,
    });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket:      this.opts.bucket,
        Key:         key,
        Body:        data,
        ContentType: contentType,
      }),
    );
  }

  async getStream(key: string): Promise<Readable> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return out.Body as Readable;
    } catch (err: any) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
        throw new NotFoundException('File not found.');
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
  }
}
