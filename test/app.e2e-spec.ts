import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('Gemini File Search API (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET / serves the HTML control panel', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Content-Type', /text\/html/);
  });

  it('GET /health reports the service is up', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        if (res.body?.status !== 'ok') {
          throw new Error(`unexpected health body: ${JSON.stringify(res.body)}`);
        }
      });
  });

  it('GET /v1/stores rejects requests without an API key', () => {
    return request(app.getHttpServer())
      .get('/v1/stores')
      .expect((res) => {
        // 401 when KB_API_KEY is configured, 503 when it is not.
        if (res.status !== 401 && res.status !== 503) {
          throw new Error(`expected 401 or 503, got ${res.status}`);
        }
      });
  });
});
