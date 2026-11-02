import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule } from './app/app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';

export const API_PREFIX = 'api/v1';

/** Applies the global HTTP configuration. Shared by main.ts and the e2e tests. */
export function configureApp(app: NestExpressApplication) {
  const isProd = process.env.NODE_ENV === 'production';

  app.setGlobalPrefix(API_PREFIX, { exclude: ['health'] });

  // Behind a reverse proxy (Caddy/Nginx) so req.ip and secure cookies work.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cookieParser());

  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin:      origins.length ? origins : !isProd,
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

function setupSwagger(app: NestExpressApplication) {
  const config = new DocumentBuilder()
    .setTitle('ROF LMS API')
    .setDescription(
      'Rwanda Olympiad Foundation Learning Management System — Mathematics.\n\n' +
      'Authenticate with POST /api/v1/auth/login, then send `Authorization: Bearer <access_token>`.\n' +
      'Errors always have the shape `{ statusCode, error, code, message, details?, requestId }`.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  // Every route needs the bearer token unless marked @Public().
  document.security = [{ bearer: [] }];
  SwaggerModule.setup('api/docs', app, document, {
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
