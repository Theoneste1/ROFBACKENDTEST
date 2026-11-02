import {
  Body,
  Controller,
  Get,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';

import { AuthService } from './auth.service.js';
import { RegisterStudentDto } from './dto/register-student.dto.js';
import { RegisterAdminDto } from './dto/register-admin.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { Roles } from './decorators/roles.decorator.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─── Student self-registration (public) ────────────────────────────────────
  @Post('register/student')
  async registerStudent(@Body() body: RegisterStudentDto) {
    return this.authService.registerStudent(body);
  }

  // ─── Admin account creation (ADMIN only) ───────────────────────────────────
  @Post('register/admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  async registerAdmin(@Body() body: RegisterAdminDto, @Request() req: any) {
    return this.authService.registerAdmin(body, req.user.id);
  }

  // ─── Login (all roles, public) ─────────────────────────────────────────────
  @Post('login')
  async login(@Body() body: LoginDto) {
    return this.authService.login(body);
  }

  // ─── Logout (any authenticated user) ──────────────────────────────────────
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout(@Request() req: any) {
    const { jti, exp, id, role } = req.user;

    if (!jti) {
      // Token was issued before jti support was added — nothing to blacklist.
      return { message: 'Logged out successfully.' };
    }

    // exp is in seconds (Unix epoch); convert to Date for the blacklist record.
    const expiresAt = exp ? new Date(exp * 1000) : new Date(Date.now() + 86_400_000);

    await this.authService.logout(jti, expiresAt, id, role);

    return { message: 'Logged out successfully.' };
  }

  // ─── Who am I? (any authenticated user) ───────────────────────────────────
  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMe(@Request() req: any) {
    return {
      id:       req.user.id,
      username: req.user.username,
      role:     req.user.role,
    };
  }
}
