import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { ApiKeyGuard } from './common/api-key.guard';
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
  ],
  controllers: [
    AppController,
    StoresController,
    SearchController,
    DriveController,
  ],
  providers: [ApiKeyGuard],
})
export class AppModule {}
