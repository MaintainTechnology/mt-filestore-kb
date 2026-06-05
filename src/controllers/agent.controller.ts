import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { AgentService } from '../anthropic/agent.service';
import { ApiKeyGuard } from '../common/api-key.guard';
import { AgentDto } from '../dto/agent.dto';

@ApiTags('Agent')
@ApiSecurity('x-api-key')
@ApiHeader({
  name: 'x-anthropic-key',
  required: false,
  description:
    'Optional Anthropic API key to use instead of the server default (ANTHROPIC_API_KEY).',
})
@ApiHeader({
  name: 'x-gemini-key',
  required: false,
  description:
    'Optional Gemini API key forwarded to the search/list tools instead of the server default.',
})
@UseGuards(ApiKeyGuard)
@Controller('v1/agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post()
  @ApiOperation({
    summary:
      'Ask the Claude signage-compliance agent that researches the brand-guideline file stores',
    description:
      'Runs a Claude tool-use loop with access to list_stores, list_documents, search_store, and get_drive_status. Claude retrieves the governing brand signage rules from the File Search stores and returns a grounded, cited compliance assessment plus the full tool trace. It does not see the franchisee photos — the image vision pass is separate; this agent supplements those findings with the authoritative brand rules.',
  })
  ask(
    @Body() dto: AgentDto,
    @Headers('x-anthropic-key') anthropicKey?: string,
    @Headers('x-gemini-key') geminiKey?: string,
  ) {
    return this.agent.run({
      query: dto.query,
      defaultStore: dto.defaultStore,
      model: dto.model,
      systemInstruction: dto.systemInstruction,
      maxIterations: dto.maxIterations,
      includeTrace: dto.includeTrace,
      anthropicKey,
      geminiKey,
    });
  }
}
