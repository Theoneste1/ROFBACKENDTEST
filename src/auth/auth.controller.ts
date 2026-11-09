import {
  Body,
  Controller,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';

import { AuthService } from './auth.service.js';
import { ActivationService } from './activation.service.js';
import { RegisterStudentDto } from './dto/register-student.dto.js';
import { RegisterAdminDto } from './dto/register-admin.dto.js';
import { LoginDto } from './dto/login.dto.js';
import {
  ActivateAccountDto,
  ActivationTokenDto,
  ResendActivationDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  RefreshTokenDto,
  ResetPasswordDto,
} from './dto/password.dto.js';
import { Roles } from './decorators/roles.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import type { ClientInfo, IssuedTokens } from './token.service.js';
import { Authenticated } from '../common/decorators/authenticated.decorator.js';

export const REFRESH_COOKIE = 'rof_refresh';

/** Strict limit for credential endpoints: 10 requests per minute per IP. */
const CREDENTIAL_LIMIT = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config:      ConfigService,
    private readonly activation:  ActivationService,
  ) {}

  // ─── Student self-registration (public) ────────────────────────────────────
  @Public()
  @Throttle(CREDENTIAL_LIMIT)
  @Post('register/student')
  registerStudent(@Body() body: RegisterStudentDto) {
    return this.authService.registerStudent(body);
  }

  // ─── Admin account creation (ADMIN only) ───────────────────────────────────
  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post('register/admin')
  registerAdmin(@Body() body: RegisterAdminDto, @CurrentUser() user: AuthUser) {
    return this.authService.registerAdmin(body, user);
  }

  // ─── Login (all roles, public) ─────────────────────────────────────────────
  /**
   * Returns a short-lived access token and a refresh token. The refresh token
   * is also set as an httpOnly cookie for browser clients.
   */
  @Public()
  @Throttle(CREDENTIAL_LIMIT)
  @HttpCode(200)
  @Post('login')
  async login(
    @Body() body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(body, clientInfo(req));
    this.setRefreshCookie(res, result);
    return result;
  }

  // ─── Refresh (public — authenticated by the refresh token itself) ──────────
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('refresh')
  async refresh(
    @Body() body: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token  = body.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
    const tokens = await this.authService.refresh(token ?? '', clientInfo(req));
    this.setRefreshCookie(res, tokens);
    return tokens;
  }

  // ─── Logout (current session) ──────────────────────────────────────────────
  @ApiBearerAuth()
  @HttpCode(200)
  @Post('logout')
  @Authenticated()
  async logout(
    @CurrentUser() user: AuthUser,
    @Body() body: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logout(user, body.refreshToken ?? req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
    return { message: 'Logged out successfully.' };
  }

  // ─── Logout everywhere ─────────────────────────────────────────────────────
  @ApiBearerAuth()
  @HttpCode(200)
  @Post('logout-all')
  @Authenticated()
  async logoutAll(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.authService.logoutAll(user);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
    return { message: 'All sessions have been signed out.' };
  }

  // ─── Account activation (public — authenticated by the link token) ────────

  /** Check an activation link before showing the form (who it is for, whether a password is needed). */
  @Public()
  @Throttle(CREDENTIAL_LIMIT)
  @HttpCode(200)
  @Post('activation/inspect')
  inspectActivation(@Body() body: ActivationTokenDto) {
    return this.activation.inspect(body.token);
  }

  /** Activate an invited (choose a password) or unverified account. */
  @Public()
  @Throttle(CREDENTIAL_LIMIT)
  @HttpCode(200)
  @Post('activate')
  activate(@Body() body: ActivateAccountDto) {
    return this.activation.activate(body.token, body.password);
  }

  /** Send a new activation link. Same answer whether or not the e-mail exists. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('resend-activation')
  resendActivation(@Body() body: ResendActivationDto) {
    return this.activation.resendForEmail(body.email);
  }

  // ─── Passwords ─────────────────────────────────────────────────────────────
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('forgot-password')
  forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.authService.forgotPassword(body.email);
  }

  @Public()
  @Throttle(CREDENTIAL_LIMIT)
  @HttpCode(200)
  @Post('reset-password')
  resetPassword(@Body() body: ResetPasswordDto) {
    return this.authService.resetPassword(body.token, body.newPassword);
  }

  @ApiBearerAuth()
  @Throttle(CREDENTIAL_LIMIT)
  @Patch('password')
  @Authenticated()
  changePassword(@CurrentUser() user: AuthUser, @Body() body: ChangePasswordDto) {
    return this.authService.changePassword(user.id, body.currentPassword, body.newPassword);
  }

  // ─── Cookie helpers ────────────────────────────────────────────────────────

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure:   this.config.get('NODE_ENV') === 'production',
      sameSite: 'strict',
      path:     '/api/v1/auth',
    };
  }

  private setRefreshCookie(res: Response, tokens: Pick<IssuedTokens, 'refresh_token' | 'refresh_expires_at'>) {
    res.cookie(REFRESH_COOKIE, tokens.refresh_token, {
      ...this.cookieOptions(),
      expires: tokens.refresh_expires_at,
    });
  }
}

function clientInfo(req: Request): ClientInfo {
  return { userAgent: req.get('user-agent') ?? undefined, ip: req.ip };
}
