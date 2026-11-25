import { SetMetadata } from '@nestjs/common';

export const BEFORE_BANKING_KEY = 'allowedBeforeBankingDetails';

/**
 * The route stays usable by a Teacher, Coach or Head Coach who still has to give their banking information (owner
 * 2026-11-25): their profile and permissions, the banking form, the gender step, changing their password, signing out
 * everywhere. Every other route answers 403 BANKING_DETAILS_REQUIRED for them (BankingDetailsGuard).
 */
export const AllowedBeforeBankingDetails = () => SetMetadata(BEFORE_BANKING_KEY, true);
