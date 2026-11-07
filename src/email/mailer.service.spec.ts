import { addressOf, DEFAULT_FROM, MailerService } from './mailer.service.js';

const send = vi.fn();
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(function () { return { emails: { send } }; }),
}));

function mailer(env: Record<string, string | undefined>) {
  const config = { get: (key: string) => env[key] };
  const service = new MailerService(config as any);
  service.onModuleInit();
  return service;
}

const mail = { to: 'jeanne@example.org', subject: 'Hello', text: 'Plain', html: '<p>Html</p>', idempotencyKey: 'email-delivery/1' };

describe('MailerService', () => {
  beforeEach(() => { send.mockReset(); });

  it('is a dry run without RESEND_API_KEY and never calls Resend', async () => {
    const service = mailer({});
    expect(service.isDryRun).toBe(true);
    const result = await service.sendOne(mail);
    expect(result).toMatchObject({ accepted: true, error: null });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends through Resend with sender, reply-to, both bodies and the idempotency key', async () => {
    send.mockResolvedValue({ data: { id: 're_1' }, error: null });
    const service = mailer({ RESEND_API_KEY: 're_x', EMAIL_FROM: 'ROF <info@rof.rw>', EMAIL_MAX_PER_SECOND: '100' });
    const result = await service.sendOne(mail);

    expect(result).toEqual({ messageId: 're_1', accepted: true, error: null, permanent: false });
    expect(send).toHaveBeenCalledWith(
      { from: 'ROF <info@rof.rw>', to: 'jeanne@example.org', subject: 'Hello', text: 'Plain', html: '<p>Html</p>', replyTo: 'info@rof.rw' },
      { idempotencyKey: 'email-delivery/1' },
    );
  });

  it('uses the ROF sender by default and EMAIL_REPLY_TO when set', async () => {
    send.mockResolvedValue({ data: { id: 're_2' }, error: null });
    await mailer({ RESEND_API_KEY: 're_x', EMAIL_REPLY_TO: 'help@rof.rw' }).sendOne(mail);
    expect(send.mock.calls[0][0]).toMatchObject({ from: DEFAULT_FROM, replyTo: 'help@rof.rw' });
  });

  it('redirects every e-mail to EMAIL_REDIRECT_TO and names the real recipient in the subject', async () => {
    send.mockResolvedValue({ data: { id: 're_3' }, error: null });
    await mailer({ RESEND_API_KEY: 're_x', EMAIL_REDIRECT_TO: 'tester@rof.rw' }).sendOne(mail);
    expect(send.mock.calls[0][0]).toMatchObject({ to: 'tester@rof.rw', subject: '[to jeanne@example.org] Hello' });
  });

  it.each([
    [{ statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' }, true],
    [{ statusCode: 403, name: 'validation_error', message: 'The domain is not verified.' }, false],
    [{ statusCode: 401, name: 'invalid_api_key', message: 'API key is invalid' }, false],
    [{ statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' }, false],
    [{ statusCode: 500, name: 'internal_server_error', message: 'Oops' }, false],
  ])('reports Resend error %o (permanent: %s)', async (error, permanent) => {
    send.mockResolvedValue({ data: null, error });
    const result = await mailer({ RESEND_API_KEY: 're_x' }).sendOne(mail);
    expect(result).toMatchObject({ accepted: false, messageId: null, permanent });
    expect(result.error).toContain(`${error.statusCode} ${error.name}`);
  });

  it('never throws on a network failure', async () => {
    send.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    const result = await mailer({ RESEND_API_KEY: 're_x' }).sendOne(mail);
    expect(result.accepted).toBe(false);
    expect(result.permanent).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.error).toBe('fetch failed');
  });

  it('paces requests to EMAIL_MAX_PER_SECOND', async () => {
    send.mockResolvedValue({ data: { id: 're' }, error: null });
    const service = mailer({ RESEND_API_KEY: 're_x', EMAIL_MAX_PER_SECOND: '10' });
    const start = Date.now();
    await Promise.all([1, 2, 3].map(() => service.sendOne(mail)));
    expect(Date.now() - start).toBeGreaterThanOrEqual(190); // 3 sends, 100 ms apart
  });

  it('never uses the real Resend API under NODE_ENV=test', async () => {
    const service = mailer({ RESEND_API_KEY: 're_real', NODE_ENV: 'test' });
    expect(service.isDryRun).toBe(true);
    await service.sendOne(mail);
    expect(send).not.toHaveBeenCalled();
  });

  it('parses the address out of a "Name <address>" sender', () => {
    expect(addressOf('Rwanda Olympiad Foundation <info@rwandaolympiadfoundation.org>')).toBe('info@rwandaolympiadfoundation.org');
    expect(addressOf('info@rof.rw')).toBe('info@rof.rw');
  });
});
