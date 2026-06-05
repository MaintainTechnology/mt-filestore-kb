import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class AgentDto {
  @ApiProperty({
    description:
      'The natural-language question for the agent. The agent will decide which tools to call (list_stores, list_documents, search_store, get_drive_status) to answer it.',
    example: 'What does the rescue brief say about milestone reporting, and which other docs cover similar ground?',
  })
  @IsString()
  @MinLength(1)
  query!: string;

  @ApiPropertyOptional({
    description:
      'Optional default store id or full "fileSearchStores/..." name. The agent uses this when its tool call omits an explicit store_id.',
    example: 'fileSearchStores/abc123xyz',
  })
  @IsOptional()
  @IsString()
  defaultStore?: string;

  @ApiPropertyOptional({
    description:
      'Override the Anthropic model used for the agent loop. Defaults to ANTHROPIC_MODEL from .env (claude-opus-4-8).',
    example: 'claude-sonnet-4-6',
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({
    description:
      'Override the system instruction handed to Claude. Use this to change persona, output style, or refusal behaviour. Leave empty for the built-in research-agent prompt.',
  })
  @IsOptional()
  @IsString()
  systemInstruction?: string;

  @ApiPropertyOptional({
    description:
      'Cap on tool-use iterations. Default 10, max 20. Higher = more "deep research" depth but more cost and latency.',
    example: 10,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxIterations?: number;

  @ApiPropertyOptional({
    description:
      'Include the per-tool-call trace in the response. Default true. Set false in production clients that only want the answer.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  includeTrace?: boolean;
}
