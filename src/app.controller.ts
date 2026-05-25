import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import * as fs from 'fs';
import * as path from 'path';

@ApiTags('Service')
@Controller()
export class AppController {
  private readonly publicDir = path.join(process.cwd(), 'public');

  private readPage(file: string, title: string): string {
    const full = path.join(this.publicDir, file);
    if (fs.existsSync(full)) return fs.readFileSync(full, 'utf-8');
    return `<!doctype html><title>${title}</title><h1>${title} page not found.</h1><p>The server must be started from the project root so it can find <code>public/${file}</code>. The API docs are at <a href="/api">/api</a>.</p>`;
  }

  /** Editorial landing page. */
  @Get()
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/html; charset=utf-8')
  home(): string {
    return this.readPage('index.html', 'Gemini File Search API');
  }

  /** Ask + Sync + Activity in one operations console. */
  @Get('console')
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/html; charset=utf-8')
  console(): string {
    return this.readPage('console.html', 'Console');
  }

  /** Auth keys + stores + direct file upload. */
  @Get('configure')
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/html; charset=utf-8')
  configure(): string {
    return this.readPage('configure.html', 'Configure');
  }

  /** Sortable / filterable browser of a store's indexed documents. */
  @Get('documents')
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/html; charset=utf-8')
  documents(): string {
    return this.readPage('documents.html', 'Documents');
  }

  @Get('health')
  @ApiOperation({ summary: 'Health check' })
  health() {
    return {
      status: 'ok',
      service: 'gemini-file-search-api',
      time: new Date().toISOString(),
    };
  }
}
