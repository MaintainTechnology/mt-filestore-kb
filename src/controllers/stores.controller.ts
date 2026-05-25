import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/api-key.guard';
import { CreateStoreDto } from '../dto/create-store.dto';
import { GeminiService } from '../gemini/gemini.service';

@ApiTags('Stores')
@ApiSecurity('x-api-key')
@ApiHeader({
  name: 'x-gemini-key',
  required: false,
  description: 'Optional Gemini API key to use instead of the server default.',
})
@UseGuards(ApiKeyGuard)
@Controller('v1/stores')
export class StoresController {
  constructor(private readonly gemini: GeminiService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new File Search store' })
  createStore(
    @Body() dto: CreateStoreDto,
    @Headers('x-gemini-key') geminiKey?: string,
  ) {
    return this.gemini.createStore(
      dto.displayName,
      dto.embeddingModel,
      geminiKey,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List all File Search stores' })
  async listStores(@Headers('x-gemini-key') geminiKey?: string) {
    return { stores: await this.gemini.listStores(geminiKey) };
  }

  @Get(':storeId')
  @ApiOperation({ summary: 'Get a single store by id' })
  getStore(
    @Param('storeId') storeId: string,
    @Headers('x-gemini-key') geminiKey?: string,
  ) {
    return this.gemini.getStore(storeId, geminiKey);
  }

  @Delete(':storeId')
  @ApiOperation({ summary: 'Delete a store' })
  @ApiQuery({
    name: 'force',
    required: false,
    description: 'Set to true to delete a store that still contains documents.',
  })
  async deleteStore(
    @Param('storeId') storeId: string,
    @Query('force') force?: string,
    @Headers('x-gemini-key') geminiKey?: string,
  ) {
    await this.gemini.deleteStore(
      storeId,
      force === 'true' || force === '1',
      geminiKey,
    );
    return { deleted: true, store: this.gemini.normalizeStoreName(storeId) };
  }

  @Get(':storeId/documents')
  @ApiOperation({ summary: 'List the documents indexed in a store' })
  async listDocuments(
    @Param('storeId') storeId: string,
    @Headers('x-gemini-key') geminiKey?: string,
  ) {
    return { documents: await this.gemini.listDocuments(storeId, geminiKey) };
  }

  @Post(':storeId/upload')
  @ApiOperation({
    summary: 'Upload a file and index it into a store',
    description:
      'Send a multipart/form-data request with a "file" field. The file is uploaded to Gemini, then chunked, embedded and indexed. Large files may take a while.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        displayName: { type: 'string' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }),
  )
  async upload(
    @Param('storeId') storeId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('displayName') displayName?: string,
    @Headers('x-gemini-key') geminiKey?: string,
  ) {
    if (!file) {
      throw new BadRequestException(
        'No file received. Send a multipart/form-data request with a field named "file".',
      );
    }
    const document = await this.gemini.uploadFile(
      storeId,
      {
        buffer: file.buffer,
        filename: file.originalname,
        mimeType: file.mimetype,
      },
      displayName,
      geminiKey,
    );
    return {
      indexed: true,
      store: this.gemini.normalizeStoreName(storeId),
      document,
    };
  }
}
