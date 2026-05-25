import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

/**
 * Protects every /v1 endpoint. The caller must send the Knowledge Base API
 * key in the `x-api-key` header (an `?api_key=` query param is also accepted
 * for quick tests). The expected value comes from KB_API_KEY in .env.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = (this.config.get<string>('KB_API_KEY') || '').trim();

    if (!expected) {
      throw new ServiceUnavailableException(
        'KB_API_KEY is not configured on the server. Set it in .env.',
      );
    }

    const headerKey = request.headers['x-api-key'];
    const queryKey = request.query?.api_key;
    const provided = (
      (Array.isArray(headerKey) ? headerKey[0] : headerKey) ||
      (Array.isArray(queryKey) ? queryKey[0] : queryKey) ||
      ''
    )
      .toString()
      .trim();

    if (!provided) {
      throw new UnauthorizedException(
        'Missing API key. Provide it in the "x-api-key" header.',
      );
    }
    if (provided !== expected) {
      throw new UnauthorizedException('Invalid API key.');
    }
    return true;
  }
}
