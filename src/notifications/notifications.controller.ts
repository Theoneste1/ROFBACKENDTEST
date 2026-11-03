import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';

import { NotificationsService } from './notifications.service.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { PaginationQueryDto } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import { NotificationCategory } from '../generated/prisma/client.js';

class ListNotificationsDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unreadOnly?: boolean;

  @IsOptional() @IsEnum(NotificationCategory) category?: NotificationCategory;

  /** Event type, e.g. "assignment.published". */
  @IsOptional() @IsString() @Length(1, 100) type?: string;
}

class MarkReadDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  ids: string[];
}

class PreferenceDto {
  @IsEnum(NotificationCategory)
  category: NotificationCategory;

  @IsBoolean()
  emailEnabled: boolean;
}

class UpdatePreferencesDto {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PreferenceDto)
  preferences: PreferenceDto[];
}

@ApiTags('Notifications')
@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  list(@CurrentUser() user: AuthUser, @Query() query: ListNotificationsDto) {
    return this.notifications.list(user.id, query);
  }

  @Get('notifications/unread-count')
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user.id);
  }

  /** Mark up to 100 notifications read. Declared before :id routes. */
  @Post('notifications/read')
  @HttpCode(200)
  markManyRead(@CurrentUser() user: AuthUser, @Body() body: MarkReadDto) {
    return this.notifications.markManyRead(user.id, body.ids);
  }

  @Get('notifications/:id')
  findOne(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.findOne(user.id, id);
  }

  @Patch('notifications/:id/read')
  markRead(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user.id, id);
  }

  @Patch('notifications/:id/unread')
  markUnread(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markUnread(user.id, id);
  }

  @Post('notifications/read-all')
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }

  /** E-mail preferences per category. ACCOUNT e-mails cannot be disabled. */
  @Get('me/notification-preferences')
  preferences(@CurrentUser() user: AuthUser) {
    return this.notifications.getPreferences(user.id);
  }

  @Put('me/notification-preferences')
  updatePreferences(@CurrentUser() user: AuthUser, @Body() body: UpdatePreferencesDto) {
    return this.notifications.updatePreferences(user.id, body.preferences);
  }
}
