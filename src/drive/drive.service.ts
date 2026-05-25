import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drive_v3, google } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

/**
 * Google-native files (Docs/Sheets/Slides) are not real files — they must be
 * exported to a concrete format before they can be indexed.
 */
const GOOGLE_EXPORT: Record<string, { mimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/pdf',
    extension: '.pdf',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/pdf',
    extension: '.pdf',
  },
  'application/vnd.google-apps.drawing': {
    mimeType: 'image/png',
    extension: '.png',
  },
};

/** File types Gemini File Search cannot index — skipped automatically. */
const SKIP_EXTENSIONS = new Set([
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv',
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg',
  '.zip', '.rar', '.7z', '.tar', '.gz',
  '.exe', '.dmg', '.iso', '.psd', '.ai', '.sketch',
]);

const MAX_FILE_BYTES = 100 * 1024 * 1024; // File Search hard limit: 100 MB/file

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
}

export type FileAction = 'export' | 'download' | 'skip';

export interface ClassifiedFile {
  meta: DriveFileMeta;
  action: FileAction;
  reason?: string;
}

/**
 * Reads files out of Google Drive using a service account. The user shares the
 * folder they want indexed with the service account's email address.
 */
@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);
  private drive: drive_v3.Drive | null = null;
  private configError: string | null = null;
  private serviceAccountEmailValue: string | null = null;

  constructor(private readonly config: ConfigService) {
    this.initialize();
  }

  private initialize(): void {
    const inlineJson = (
      this.config.get<string>('GOOGLE_SERVICE_ACCOUNT_JSON') || ''
    ).trim();
    const filePath = (
      this.config.get<string>('GOOGLE_SERVICE_ACCOUNT_FILE') || ''
    ).trim();

    let credentials: any;
    try {
      if (inlineJson) {
        credentials = JSON.parse(inlineJson);
      } else if (filePath) {
        const resolved = path.isAbsolute(filePath)
          ? filePath
          : path.join(process.cwd(), filePath);
        if (!fs.existsSync(resolved)) {
          this.configError = `Service account file not found at "${resolved}". See the README to set up Drive access.`;
          this.logger.warn(this.configError);
          return;
        }
        credentials = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
      } else {
        this.configError =
          'Google Drive is not configured. Set GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON in .env.';
        this.logger.warn(this.configError);
        return;
      }
    } catch (err) {
      this.configError = `Could not read the service account credentials: ${(err as Error).message}`;
      this.logger.error(this.configError);
      return;
    }

    try {
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: DRIVE_SCOPES,
      });
      this.drive = google.drive({ version: 'v3', auth });
      this.serviceAccountEmailValue = credentials.client_email || null;
      this.logger.log(
        `Google Drive ready. Service account: ${this.serviceAccountEmailValue ?? 'unknown'}`,
      );
    } catch (err) {
      this.configError = `Failed to initialize the Drive client: ${(err as Error).message}`;
      this.logger.error(this.configError);
    }
  }

  isConfigured(): boolean {
    return this.drive !== null;
  }

  get serviceAccountEmail(): string | null {
    return this.serviceAccountEmailValue;
  }

  get configurationError(): string | null {
    return this.configError;
  }

  private requireDrive(): drive_v3.Drive {
    if (!this.drive) {
      throw new ServiceUnavailableException(
        this.configError || 'Google Drive is not configured.',
      );
    }
    return this.drive;
  }

  /** Accepts a raw folder ID or a full Drive URL and returns just the ID. */
  parseFolderId(raw: string): string {
    const value = (raw || '').trim();
    if (!value) return '';
    if (value.includes('drive.google.com')) {
      const folderMatch = value.match(/\/folders\/([a-zA-Z0-9_-]+)/);
      if (folderMatch) return folderMatch[1];
      const idMatch = value.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (idMatch) return idMatch[1];
    }
    return value;
  }

  /** Recursively lists every non-folder file under folderId, including subfolders. */
  async listFiles(folderId: string): Promise<DriveFileMeta[]> {
    const drive = this.requireDrive();
    const discovered: DriveFileMeta[] = [];
    const pending: string[] = [folderId];
    const seen = new Set<string>();
    try {
      while (pending.length > 0) {
        const current = pending.pop() as string;
        if (seen.has(current)) continue;
        seen.add(current);
        let pageToken: string | undefined;
        do {
          const res = await drive.files.list({
            q: `'${current}' in parents and trashed = false`,
            fields:
              'nextPageToken, files(id, name, mimeType, modifiedTime, size)',
            pageSize: 1000,
            pageToken,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });
          for (const item of res.data.files || []) {
            if (item.mimeType === 'application/vnd.google-apps.folder') {
              if (item.id) pending.push(item.id);
            } else if (item.id && item.name && item.mimeType) {
              discovered.push({
                id: item.id,
                name: item.name,
                mimeType: item.mimeType,
                modifiedTime: item.modifiedTime ?? undefined,
                size: item.size ?? undefined,
              });
            }
          }
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);
      }
      return discovered;
    } catch (err) {
      this.fail('listFiles', err);
    }
  }

  /** Decides whether a file should be exported, downloaded, or skipped. */
  classify(meta: DriveFileMeta): ClassifiedFile {
    const mime = meta.mimeType || '';
    if (GOOGLE_EXPORT[mime]) {
      return { meta, action: 'export' };
    }
    if (mime.startsWith('application/vnd.google-apps')) {
      return {
        meta,
        action: 'skip',
        reason: `unsupported Google type (${mime})`,
      };
    }
    const ext = path.extname(meta.name || '').toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) {
      return {
        meta,
        action: 'skip',
        reason: `file type not indexable (${ext || 'no extension'})`,
      };
    }
    const size = parseInt(meta.size || '0', 10);
    if (size > MAX_FILE_BYTES) {
      return {
        meta,
        action: 'skip',
        reason: `larger than 100 MB (${Math.round(size / (1024 * 1024))} MB)`,
      };
    }
    return { meta, action: 'download' };
  }

  /** Downloads (or exports) one Drive file into memory. */
  async downloadFile(
    meta: DriveFileMeta,
  ): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
    const drive = this.requireDrive();
    try {
      const exportSpec = GOOGLE_EXPORT[meta.mimeType];
      if (exportSpec) {
        const res = await drive.files.export(
          { fileId: meta.id, mimeType: exportSpec.mimeType },
          { responseType: 'arraybuffer' },
        );
        let filename = meta.name;
        if (!filename.toLowerCase().endsWith(exportSpec.extension)) {
          filename += exportSpec.extension;
        }
        return {
          buffer: this.toBuffer(res.data),
          filename,
          mimeType: exportSpec.mimeType,
        };
      }
      const res = await drive.files.get(
        { fileId: meta.id, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' },
      );
      return {
        buffer: this.toBuffer(res.data),
        filename: meta.name,
        mimeType: meta.mimeType,
      };
    } catch (err) {
      this.fail(`downloadFile(${meta.name})`, err);
    }
  }

  private toBuffer(data: unknown): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    return Buffer.from(data as any);
  }

  private fail(context: string, err: any): never {
    const status: unknown = err?.response?.status ?? err?.code;
    const message =
      err?.response?.data?.error?.message ||
      err?.errors?.[0]?.message ||
      err?.message ||
      'Unknown Drive error';
    this.logger.error(`${context} failed: ${message}`);
    const httpStatus =
      typeof status === 'number' && status >= 400 && status < 600
        ? status
        : HttpStatus.BAD_GATEWAY;
    throw new HttpException(
      `Google Drive error during ${context}: ${message}`,
      httpStatus,
    );
  }
}
