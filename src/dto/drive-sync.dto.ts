import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

export class DriveSyncDto {
  @ApiProperty({
    description: 'A Google Drive folder ID or its full folder URL.',
    example: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQr',
  })
  @IsString()
  @MinLength(1)
  folderId!: string;

  @ApiPropertyOptional({
    description: 'An existing store (id or full name) to ingest the files into.',
    example: 'fileSearchStores/abc123xyz',
  })
  @IsOptional()
  @IsString()
  store?: string;

  @ApiPropertyOptional({
    description:
      'If no existing store is given, create a new one with this display name.',
    example: 'ngm-knowledge-base',
  })
  @IsOptional()
  @IsString()
  createStore?: string;

  @ApiPropertyOptional({
    description: 'Ingest at most this many files (useful for a first test).',
    example: 5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'If true, list the files that would be ingested without uploading anything.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
