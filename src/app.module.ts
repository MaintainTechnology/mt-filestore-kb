import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnthropicModule } from './anthropic/anthropic.module';
import { AppController } from './app.controller';
import { ApiKeyGuard } from './common/api-key.guard';
import { AgentController } from './controllers/agent.controller';
import { DriveController } from './controllers/drive.controller';
import { SearchController } from './controllers/search.controller';
import { StoresController } from './controllers/stores.controller';
import { DriveModule } from './drive/drive.module';
import { GeminiModule } from './gemini/gemini.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    GeminiModule,
    DriveModule,
    AnthropicModule,
  ],
  controllers: [
    AppController,
    StoresController,
    SearchController,
    DriveController,
    AgentController,
  ],
  providers: [ApiKeyGuard],
})
export class AppModule {}
