import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

import { AppModule } from './app/app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { buildOpenApiDocument } from './openapi.js';

export const API_PREFIX = 'api/v1';

/** Applies the global HTTP configuration. Shared by main.ts and the e2e tests. */
export function configureApp(app: NestExpressApplication) {
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health'] });

  // Behind a reverse proxy (Caddy/Nginx) so req.ip and secure cookies work.
  // TRUST_PROXY = number of proxy hops (default 1); "false" when clients reach
  // the API directly — otherwise X-Forwarded-For could fake the client address
  // and slip past the per-IP rate limits.
  app.set('trust proxy', trustProxy(process.env.TRUST_PROXY));
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cookieParser());
  app.use(requestSizeLimit(Number(process.env.MAX_UPLOAD_REQUEST_MB ?? 100)));

  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  // No origins configured → no cross-origin access (set CORS_ORIGINS for the frontend).
  app.enableCors({
    origin:      origins.length ? origins : false,
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist:            true,
      forbidNonWhitelisted: true,
      transform:            true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  return app;
}

function trustProxy(value: string | undefined): number | boolean {
  if (value === undefined || value === '') return 1;
  if (value === 'false') return false;
  if (value === 'true') return true;
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 ? hops : 1;
}

/**
 * Refuse request bodies over the cap before anything is read. Uploads are
 * buffered in memory for type checks, so this bounds memory per request
 * (multer also limits each file by its purpose).
 */
function requestSizeLimit(maxMb: number) {
  const maxBytes = maxMb * 1024 * 1024;
  return (req: Request, res: Response, next: NextFunction) => {
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > maxBytes) {
      res.status(413).json({
        statusCode: 413, error: 'Payload Too Large', code: 'PAYLOAD_TOO_LARGE',
        message: `The request is larger than ${maxMb} MB.`,
      });
      return;
    }
    next();
  };
}

function setupSwagger(app: NestExpressApplication) {
  SwaggerModule.setup('api/docs', app, buildOpenApiDocument(app), {
    jsonDocumentUrl: 'api/docs-json',
    swaggerOptions: { persistAuthorization: true },
  });
}

async function bootstrap() {
  const isProd = process.env.NODE_ENV === 'production';
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new ConsoleLogger({ json: isProd, colors: !isProd }),
  });

  configureApp(app);
  if (!isProd || process.env.SWAGGER_ENABLED === 'true') setupSwagger(app);

  await app.listen(process.env.PORT ?? 3000);
}

// Only start the server when executed directly (not when imported by tests).
if (process.env.NODE_ENV !== 'test') {
  await bootstrap();
}
