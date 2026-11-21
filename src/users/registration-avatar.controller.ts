import { Body, Controller, Global, HttpCode, Module, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, Length } from 'class-validator';
import { Public } from '../common/decorators/public.decorator.js';
import { uploadOptions } from '../common/storage/upload-options.js';
import { RegistrationAvatarService } from './registration-avatar.service.js';

export class RegistrationAvatarDto {
  /** The `avatarUploadToken` of the registration / application answer (30 minutes). */
  @IsString() @Length(10, 600)
  token: string;
}

/**
 * OPTIONAL profile picture right after registering (REG-02): the first picture of the new student account or of the
 * pending Teacher / Coach application. 401 REGISTRATION_AVATAR_TOKEN_INVALID (expired / not valid / decided), 409
 * AVATAR_ALREADY_SET, 400 FILE_REQUIRED, 413 / 415 as every avatar upload. Registration never depends on it.
 */
@ApiTags('Auth')
@Controller('auth/register/avatar')
export class RegistrationAvatarController {
  constructor(private readonly service: RegistrationAvatarService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put()
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', uploadOptions('AVATAR', 1)))
  upload(@Body() body: RegistrationAvatarDto, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.service.upload(body.token, file);
  }
}

/** Global: the student, teacher and coach registration services issue its tokens. */
@Global()
@Module({ controllers: [RegistrationAvatarController], providers: [RegistrationAvatarService], exports: [RegistrationAvatarService] })
export class RegistrationAvatarModule {}
