import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class SearchDto {
  @ApiProperty({
    description:
      'The store to search — either the id or the full "fileSearchStores/..." resource name.',
    example: 'fileSearchStores/abc123xyz',
  })
  @IsString()
  @MinLength(1)
  store!: string;

  @ApiProperty({
    description: 'The question to ask your documents.',
    example: 'What does the Healthspan Compass talk say about sleep?',
  })
  @IsString()
  @MinLength(1)
  query!: string;

  @ApiPropertyOptional({
    description: 'Override the Gemini model used to answer.',
    example: 'gemini-2.5-flash',
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({
    description:
      'Optional metadata filter to restrict which documents are searched, e.g. author="Dr Deepti".',
    example: 'author="Dr Deepti"',
  })
  @IsOptional()
  @IsString()
  metadataFilter?: string;

  @ApiPropertyOptional({
    description:
      'Optional system instruction that frames how the model should answer. ' +
      'Leave blank to use the default signage-compliance framing. Callers ' +
      'grounding a different domain (e.g. a QuoteMate estimate store) should ' +
      'pass their own instruction so answers are framed for that domain.',
    example:
      'You are a helpful estimate assistant. Answer only from the uploaded files and the estimate result.',
  })
  @IsOptional()
  @IsString()
  systemInstruction?: string;
}
