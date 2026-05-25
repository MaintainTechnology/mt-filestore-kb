import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateStoreDto {
  @ApiProperty({
    description: 'A human-readable name for the File Search store.',
    example: 'ngm-knowledge-base',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  displayName!: string;

  @ApiPropertyOptional({
    description:
      'Embedding model. Leave blank for the API default. Use "models/gemini-embedding-2" to also index images inside documents.',
    example: 'models/gemini-embedding-2',
  })
  @IsOptional()
  @IsString()
  embeddingModel?: string;
}
