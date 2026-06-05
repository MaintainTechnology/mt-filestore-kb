import { Module } from '@nestjs/common';
import { DriveModule } from '../drive/drive.module';
import { GeminiModule } from '../gemini/gemini.module';
import { AgentService } from './agent.service';

@Module({
  imports: [GeminiModule, DriveModule],
  providers: [AgentService],
  exports: [AgentService],
})
export class AnthropicModule {}
