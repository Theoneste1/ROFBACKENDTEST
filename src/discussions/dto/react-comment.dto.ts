import { IsEnum } from 'class-validator';
import { ReactionType } from '../../generated/prisma/client.js';

export class ReactCommentDto {
  @IsEnum(ReactionType, {
    message: `type must be one of: ${Object.values(ReactionType).join(', ')}`,
  })
  type: ReactionType;
}
