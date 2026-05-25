import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/api-key.guard';
import { DriveSyncDto } from '../dto/drive-sync.dto';
import { DriveService } from '../drive/drive.service';
import { GeminiService } from '../gemini/gemini.service';

@ApiTags('Google Drive')
@ApiSecurity('x-api-key')
@ApiHeader({
  name: 'x-gemini-key',
  required: false,
  description: 'Optional Gemini API key to use instead of the server default.',
})
@UseGuards(ApiKeyGuard)
@Controller('v1/drive')
export class DriveController {
  constructor(
    private readonly drive: DriveService,
    private readonly gemini: GeminiService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Check whether Google Drive access is configured' })
  status() {
    const configured = this.drive.isConfigured();
    return {
      configured,
      serviceAccountEmail: this.drive.serviceAccountEmail,
      message: configured
        ? 'Drive is connected. Share any folder you want to index with the service account email above (Viewer access is enough).'
        : this.drive.configurationError,
    };
  }

  @Get('files')
  @ApiOperation({
    summary: 'Preview the files in a Drive folder',
    description:
      'Recursively lists a folder and shows how each file would be handled: download, export (Google Docs/Sheets/Slides), or skip.',
  })
  @ApiQuery({ name: 'folderId', description: 'Folder ID or full folder URL.' })
  async listFiles(@Query('folderId') folderId?: string) {
    const id = this.drive.parseFolderId(folderId || '');
    if (!id) throw new BadRequestException('A folderId is required.');
    const files = await this.drive.listFiles(id);
    const classified = files.map((f) => this.drive.classify(f));
    return {
      folderId: id,
      total: files.length,
      indexable: classified.filter((c) => c.action !== 'skip').length,
      files: classified.map((c) => ({
        id: c.meta.id,
        name: c.meta.name,
        mimeType: c.meta.mimeType,
        action: c.action,
        reason: c.reason,
      })),
    };
  }

  @Post('sync')
  @ApiOperation({
    summary: 'Ingest a Drive folder into a File Search store',
    description:
      'Recursively downloads every indexable file in the folder and uploads it into the store. Provide either "store" (an existing store) or "createStore" (a name for a new one). Use "dryRun" to preview, or "limit" for a first test.',
  })
  async sync(
    @Body() dto: DriveSyncDto,
    @Headers('x-gemini-key') geminiKey?: string,
  ) {
    const id = this.drive.parseFolderId(dto.folderId || '');
    if (!id) throw new BadRequestException('A folderId is required.');

    const files = await this.drive.listFiles(id);
    const classified = files.map((f) => this.drive.classify(f));
    const skipped = classified
      .filter((c) => c.action === 'skip')
      .map((c) => ({ name: c.meta.name, reason: c.reason }));
    let toProcess = classified.filter((c) => c.action !== 'skip');
    if (dto.limit && dto.limit > 0) {
      toProcess = toProcess.slice(0, dto.limit);
    }

    if (dto.dryRun) {
      return {
        dryRun: true,
        folderId: id,
        totalFiles: files.length,
        wouldIngest: toProcess.map((c) => c.meta.name),
        skipped,
      };
    }

    let storeName: string;
    if (dto.store) {
      storeName = this.gemini.normalizeStoreName(dto.store);
    } else if (dto.createStore) {
      const created = await this.gemini.createStore(
        dto.createStore,
        undefined,
        geminiKey,
      );
      storeName = created.name;
    } else {
      throw new BadRequestException(
        'Provide "store" (an existing store) or "createStore" (a name for a new store).',
      );
    }

    const results: Array<{ name: string; status: string; error?: string }> =
      [];
    let uploaded = 0;
    let failed = 0;
    for (const item of toProcess) {
      try {
        const downloaded = await this.drive.downloadFile(item.meta);
        await this.gemini.uploadFile(
          storeName,
          {
            buffer: downloaded.buffer,
            filename: downloaded.filename,
            mimeType: downloaded.mimeType,
          },
          downloaded.filename,
          geminiKey,
        );
        uploaded += 1;
        results.push({ name: item.meta.name, status: 'indexed' });
      } catch (err) {
        failed += 1;
        results.push({
          name: item.meta.name,
          status: 'failed',
          error: (err as Error).message,
        });
      }
    }

    return {
      folderId: id,
      store: storeName,
      totalFiles: files.length,
      uploaded,
      failed,
      skipped: skipped.length,
      skippedFiles: skipped,
      results,
    };
  }
}
