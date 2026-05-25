import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/api-key.guard';
import { SearchDto } from '../dto/search.dto';
import { GeminiService } from '../gemini/gemini.service';

@ApiTags('Search')
@ApiSecurity('x-api-key')
@ApiHeader({
  name: 'x-gemini-key',
  required: false,
  description: 'Optional Gemini API key to use instead of the server default.',
})
@UseGuards(ApiKeyGuard)
@Controller('v1/search')
export class SearchController {
  constructor(private readonly gemini: GeminiService) {}

  @Post()
  @ApiOperation({
    summary: 'Ask a question grounded in a File Search store',
    description:
      'Runs Gemini generateContent with the file_search tool. Returns the answer plus the document passages it was grounded on (title, page, snippet).',
  })
  search(@Body() dto: SearchDto, @Headers('x-gemini-key') geminiKey?: string) {
    return this.gemini.search(
      dto.store,
      dto.query,
      dto.model,
      dto.metadataFilter,
      geminiKey,
    );
  }
}
