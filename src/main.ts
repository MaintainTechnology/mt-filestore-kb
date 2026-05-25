import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.enableCors();

  // Serve static assets from /public (css, js, images). Controller routes still
  // win for paths they own ('/', '/console', '/configure'); everything else
  // (e.g. '/css/site.css') falls through to disk.
  app.useStaticAssets(join(process.cwd(), 'public'));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Gemini File Search API')
    .setDescription(
      'Index documents — uploaded directly or pulled from Google Drive — into ' +
        'Gemini File Search stores, then ask grounded questions with citations.\n\n' +
        'Every `/v1` endpoint requires the `x-api-key` header. Click **Authorize** ' +
        'and paste the value of `KB_API_KEY` to try the endpoints below.',
    )
    .setVersion('1.0.0')
    .addApiKey(
      { type: 'apiKey', name: 'x-api-key', in: 'header' },
      'x-api-key',
    )
    .addTag('Stores', 'Create and manage File Search stores')
    .addTag('Search', 'Ask questions grounded in your indexed documents')
    .addTag('Google Drive', 'Preview and ingest files from a Drive folder')
    .addTag('Service', 'Health and service info')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, document, {
    customSiteTitle: 'Gemini File Search API — Docs',
    swaggerOptions: { persistAuthorization: true },
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(
    `Gemini File Search API running on http://localhost:${port}  (home: / , docs: /api)`,
  );
}

void bootstrap();
