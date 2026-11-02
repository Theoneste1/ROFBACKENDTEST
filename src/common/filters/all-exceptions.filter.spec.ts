import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MulterError } from 'multer';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { AppError } from '../errors/app-error.js';
import { Prisma } from '../../generated/prisma/client.js';

function makeHost(headersSent = false) {
  const res = {
    headersSent,
    status: vi.fn(),
    json:   vi.fn(),
    end:    vi.fn(),
  };
  res.status.mockReturnValue(res);
  const req = { id: 'req-1', method: 'GET', originalUrl: '/api/v1/things' };
  const host = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

function run(exception: unknown) {
  const { host, res } = makeHost();
  new AllExceptionsFilter().catch(exception, host);
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
}

const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('msg', { code, clientVersion: 'x', meta });

describe('AllExceptionsFilter', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('wraps a standard HttpException with request context', () => {
    const { status, body } = run(new NotFoundException('Assignment not found.'));
    expect(status).toBe(404);
    expect(body).toMatchObject({
      statusCode: 404,
      error:      'Not Found',
      code:       'NOT_FOUND',
      message:    'Assignment not found.',
      requestId:  'req-1',
      path:       '/api/v1/things',
    });
    expect(typeof body.timestamp).toBe('string');
  });

  it('maps a 403 to FORBIDDEN', () => {
    expect(run(new ForbiddenException()).body).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('passes an AppError code, message and details through', () => {
    const { status, body } = run(
      new AppError(HttpStatus.CONFLICT, 'INVALID_STATE_TRANSITION', 'Nope.', { currentStatus: 'DRAFT' }),
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({
      statusCode: 409,
      error:      'Conflict',
      code:       'INVALID_STATE_TRANSITION',
      message:    'Nope.',
      details:    { currentStatus: 'DRAFT' },
    });
  });

  it('omits details when an AppError has none', () => {
    const { body } = run(new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'Nothing.'));
    expect(body).not.toHaveProperty('details');
  });

  it('turns ValidationPipe message arrays into VALIDATION_FAILED', () => {
    const { status, body } = run(new BadRequestException(['email must be an email', 'name is too short']));
    expect(status).toBe(400);
    expect(body).toMatchObject({
      code:    'VALIDATION_FAILED',
      message: 'Request validation failed.',
      details: ['email must be an email', 'name is too short'],
    });
  });

  it('maps Prisma P2002 to 409 DUPLICATE with the fields', () => {
    const { status, body } = run(prismaError('P2002', { target: ['email'] }));
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'DUPLICATE', details: { fields: ['email'] } });
  });

  it('maps Prisma P2025 to 404 NOT_FOUND', () => {
    const { status, body } = run(prismaError('P2025'));
    expect(status).toBe(404);
    expect(body).toMatchObject({ code: 'NOT_FOUND', message: 'Record not found.' });
  });

  it('maps Prisma P2003 to 409 REFERENCE_CONSTRAINT', () => {
    expect(run(prismaError('P2003')).body).toMatchObject({ statusCode: 409, code: 'REFERENCE_CONSTRAINT' });
  });

  it('maps unknown Prisma codes to a generic 500', () => {
    const { status, body } = run(prismaError('P1001'));
    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(body.message).not.toContain('msg');
  });

  it('maps MulterError LIMIT_FILE_SIZE to 413 FILE_TOO_LARGE', () => {
    const { status, body } = run(new MulterError('LIMIT_FILE_SIZE', 'file'));
    expect(status).toBe(413);
    expect(body).toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('maps other MulterErrors to 400 UPLOAD_REJECTED', () => {
    const { status, body } = run(new MulterError('LIMIT_UNEXPECTED_FILE', 'other'));
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'UPLOAD_REJECTED' });
  });

  it('returns a generic 500 for unknown errors without leaking the message', () => {
    const { status, body } = run(new Error('password=hunter2 at db.internal:5432'));
    expect(status).toBe(500);
    expect(body).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('logs server errors but not client errors', () => {
    run(new Error('boom'));
    expect(Logger.prototype.error).toHaveBeenCalledOnce();
    run(new NotFoundException());
    expect(Logger.prototype.error).toHaveBeenCalledOnce();
  });

  it('handles non-Error throwables', () => {
    expect(run('a string').status).toBe(500);
  });

  it('just ends the response when headers were already sent', () => {
    const { host, res } = makeHost(true);
    new AllExceptionsFilter().catch(new NotFoundException(), host);
    expect(res.end).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
