/**
 * Banking information (owner 2026-11-25), end to end:
 *  - a Teacher, Coach or Head Coach without complete bank details is held at the step: every route but the profile,
 *    permissions, the banking form, the gender step, password change and "sign out everywhere" answers 403
 *    BANKING_DETAILS_REQUIRED — whatever page, tab or direct API call; saving complete details ends it at once;
 *  - Teachers give all six fields: Umwalimu SACCO for both banks, personal and school numbers exactly 12 digits (the
 *    exact messages). Coaches and Head Coaches give the three personal fields only (bank from the list): school details are
 *    never asked, never block them, and any saved earlier are kept untouched; every field checked on the server;
 *  - details already saved are kept and shown; only the missing fields are reported;
 *  - Students, Administrators and Super Administrators are never asked;
 *  - administrators see the status, the missing fields and masked numbers (full only on request, audited); nobody
 *    else reaches another person's details; no account number in a list, the audit log or an error.
 * Accounts named "bank.*" get no automatic test details (test/helpers.ts completeStaffBankDetails).
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const SACCO = 'Umwalimu SACCO';
const TEACHER_MSG = 'Your Umwalimu SACCO account number must contain exactly 12 digits.';
const SCHOOL_MSG = "The school's Umwalimu SACCO account number must contain exactly 12 digits.";
const teacherDetails = {
  personalAccountName: 'Bank Teacher', personalAccountNumber: '123456789012',
  schoolAccountName: 'GS Kigali', schoolAccountNumber: '400100004567',
};
/** A coach's three personal fields: all a Coach or Head Coach gives. */
const coachDetails = { personalAccountName: 'Bank Coach', personalBankName: 'Bank of Kigali Plc', personalAccountNumber: '00012345678' };

describe('Banking information (e2e)', () => {
  let ctx: TestContext;
  const http = () => ctx.http();
  const t: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    const hash = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    const make = async (username: string, role: 'TEACHER' | 'MENTOR' | 'HEAD_COACH' | 'SUPER_ADMIN') => {
      ids[username] = (await ctx.prisma.user.create({ data: {
        username, firstName: 'Bank', lastName: role, email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), gender: 'FEMALE',
      } })).id;
      t[username] = await login(ctx, username);
    };
    for (const [u, r] of [['bank.teacher', 'TEACHER'], ['bank.teacher2', 'TEACHER'], ['bank.coach', 'MENTOR'], ['bank.hc', 'HEAD_COACH'], ['bank.partial', 'MENTOR'], ['bank.legacy.t', 'TEACHER'], ['bank.legacy.c', 'MENTOR'], ['bank.legacy.hc', 'HEAD_COACH'], ['help.super', 'SUPER_ADMIN']] as const) await make(u, r);
    // Details already given in part (e.g. by an earlier version of the form): kept, never overwritten.
    await ctx.prisma.userBankDetails.create({ data: { userId: ids['bank.partial'], personalAccountName: 'Partial Person', personalBankName: 'Ecobank Rwanda Plc' } });
    // Details saved before the rules (e.g. a coach's details kept after the account became a teacher): conflicting banks.
    await ctx.prisma.userBankDetails.create({ data: {
      userId: ids['bank.legacy.t'], personalAccountName: 'Legacy Teacher', personalBankName: 'Bank of Kigali Plc', personalAccountNumber: '123456789012',
      schoolAccountName: 'GS Legacy', schoolBankName: 'Equity Bank Rwanda Plc', schoolAccountNumber: '400100001111',
    } });
    await ctx.prisma.userBankDetails.create({ data: {
      userId: ids['bank.legacy.c'], personalAccountName: 'Legacy Coach', personalBankName: 'Ecobank Rwanda Plc', personalAccountNumber: '009988',
      schoolAccountName: 'GS Legacy C', schoolBankName: 'Bank of Kigali Plc', schoolAccountNumber: '4002222',
    } });
    // A Head Coach with school details saved by the earlier form, and the personal number still missing.
    await ctx.prisma.userBankDetails.create({ data: {
      userId: ids['bank.legacy.hc'], personalAccountName: 'Legacy HC', personalBankName: 'Access Bank Rwanda Plc',
      schoolAccountName: 'GS Legacy HC', schoolBankName: 'Equity Bank Rwanda Plc', schoolAccountNumber: '4003333',
    } });
    t.student = await login(ctx, 'student.j');
    t.admin = await login(ctx, 'admin');
    t.mentor = await login(ctx, 'mentor.j');   // a seeded coach with complete (test) details
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  const get = (url: string, token: string) => http().get(`/api/v1${url}`).set(bearer(token));
  const put = (token: string, body: object) => http().put('/api/v1/me/banking').set(bearer(token)).send(body);

  describe('the step holds incomplete Teachers, Coaches and Head Coaches', () => {
    it.each(['bank.teacher', 'bank.coach', 'bank.hc', 'bank.partial'])('%s: bankingRequired, and protected routes refused (403 BANKING_DETAILS_REQUIRED)', async (u) => {
      expect((await get('/me', t[u])).body.bankingRequired).toBe(true);
      for (const url of ['/notifications', '/programmes', '/courses']) {
        const r = await get(url, t[u]);
        expect([url, r.status, r.body.code]).toEqual([url, 403, 'BANKING_DETAILS_REQUIRED']);
      }
    });

    it('still reachable: profile, permissions, the banking form, password change, sign out everywhere', async () => {
      expect((await get('/me/permissions', t['bank.teacher2'])).status).toBe(200);
      expect((await get('/me/banking', t['bank.teacher2'])).status).toBe(200);
      // A wrong current password: refused for that reason, not by the banking step.
      const pw = await http().patch('/api/v1/auth/password').set(bearer(t['bank.teacher2'])).send({ currentPassword: 'Wrong-Pass-123!', newPassword: 'Another-Pass-2026!' });
      expect(pw.body.code).not.toBe('BANKING_DETAILS_REQUIRED');
    });

    it('other roles are never asked: Students, Administrators, Super Administrators, and coaches with complete details', async () => {
      for (const who of ['student', 'admin', 'help.super', 'mentor']) {
        expect([who, (await get('/me', t[who])).body.bankingRequired]).toEqual([who, false]);
        expect([who, (await get('/notifications', t[who])).status]).toEqual([who, 200]);
      }
      // The banking routes are for Teachers, Coaches and Head Coaches only (@Roles): every other role is refused.
      for (const who of ['student', 'admin', 'help.super']) {
        expect([who, (await get('/me/banking', t[who])).status]).toEqual([who, 403]);
        expect([who, (await put(t[who], coachDetails)).status]).toEqual([who, 403]);
      }
    });
  });

  describe('Teachers: Umwalimu SACCO, 12 digits', () => {
    it('the form: nothing saved, both banks fixed', async () => {
      const r = await get('/me/banking', t['bank.teacher']);
      expect(r.body).toMatchObject({ required: true, status: 'NOT_STARTED', rules: { personalBank: 'FIXED', schoolBank: 'FIXED', fixedBank: SACCO, personalNumberDigits: 12, banks: [SACCO] }, details: null });
      expect(r.body.missing).toHaveLength(6);
    });

    it.each([['11 digits', '12345678901'], ['13 digits', '1234567890123'], ['letters', '12345678901A'], ['symbols', '1234-5678-901']])(
      '%s: refused with the exact message; nothing saved', async (_l, n) => {
        const r = await put(t['bank.teacher'], { ...teacherDetails, personalAccountNumber: n });
        expect([r.status, r.body.code, r.body.details?.fields?.personalAccountNumber]).toEqual([400, 'BANKING_INVALID', TEACHER_MSG]);
        expect(JSON.stringify(r.body)).not.toContain(n);
        expect(await ctx.prisma.userBankDetails.findUnique({ where: { userId: ids['bank.teacher'] } })).toBeNull();
      });

    it.each([['10 digits', '4001234567'], ['13 digits', '4001234567890'], ['letters', '40012345678A'], ['symbols', '4001-2345-678']])(
      'school number of %s: refused with the exact message; nothing saved', async (_l, n) => {
        const r = await put(t['bank.teacher'], { ...teacherDetails, schoolAccountNumber: n });
        expect([r.status, r.body.code, r.body.details?.fields?.schoolAccountNumber]).toEqual([400, 'BANKING_INVALID', SCHOOL_MSG]);
        expect(Object.keys(r.body.details.fields)).toEqual(['schoolAccountNumber']);
        expect(JSON.stringify(r.body)).not.toContain(n);
        expect(await ctx.prisma.userBankDetails.findUnique({ where: { userId: ids['bank.teacher'] } })).toBeNull();
      });

    it('another bank (personal or school) refused; nothing replaced silently', async () => {
      const r = await put(t['bank.teacher'], { ...teacherDetails, personalBankName: 'Bank of Kigali Plc', schoolBankName: 'Equity Bank Rwanda Plc' });
      expect(r.status).toBe(400);
      expect(Object.keys(r.body.details.fields).sort()).toEqual(['personalBankName', 'schoolBankName']);
    });

    it('an account name with a digit refused, each name named with the exact message; nothing saved', async () => {
      const r = await put(t['bank.teacher'], { ...teacherDetails, personalAccountName: 'Bank Teacher 2', schoolAccountName: 'GS Kigali 1' });
      expect([r.status, r.body.code]).toEqual([400, 'BANKING_INVALID']);
      expect(r.body.details.fields).toEqual({
        personalAccountName: 'The bank account name must not contain numbers. Write the name exactly as on the account.',
        schoolAccountName: "The school's bank account name must not contain numbers. Write the name exactly as on the account.",
      });
      expect(await ctx.prisma.userBankDetails.findUnique({ where: { userId: ids['bank.teacher'] } })).toBeNull();
    });

    it('missing fields refused, each named', async () => {
      const r = await put(t['bank.teacher'], { personalAccountName: 'Bank Teacher' });
      expect(r.status).toBe(400);
      expect(Object.keys(r.body.details.fields).sort()).toEqual(['personalAccountNumber', 'schoolAccountName', 'schoolAccountNumber']);
    });

    it('a valid 12-digit submission completes it: both banks Umwalimu SACCO; the step ends at once; no number in the audit log', async () => {
      const r = await put(t['bank.teacher'], teacherDetails);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'COMPLETE', missing: [], details: { personalBankName: SACCO, schoolBankName: SACCO, personalAccountNumber: '123456789012' } });
      expect((await get('/me', t['bank.teacher'])).body.bankingRequired).toBe(false);
      expect((await get('/notifications', t['bank.teacher'])).status).toBe(200);
      const audit = await ctx.prisma.auditLog.findMany({ where: { action: 'BANK_DETAILS_SAVED', entityId: ids['bank.teacher'] } });
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toMatch(/123456789012|400100004567/);
    });
  });

  describe('Coaches and Head Coaches: the three personal fields only (bank from the list); no school details', () => {
    it.each(['bank.coach', 'bank.hc'])('%s: the form asks the personal fields only; an arbitrary bank or a missing personal field refused; three personal fields complete it', async (u) => {
      const form = await get('/me/banking', t[u]);
      expect(form.body.rules).toMatchObject({ personalBank: 'LIST', personalNumberDigits: null, schoolRequired: false, fields: ['personalAccountName', 'personalBankName', 'personalAccountNumber'] });
      expect(form.body.rules.banks).toHaveLength(12);
      expect(form.body.missing).toEqual(['personalAccountName', 'personalBankName', 'personalAccountNumber']);
      expect((await put(t[u], { ...coachDetails, personalBankName: 'My Own Bank' })).body.details.fields).toEqual({ personalBankName: 'Choose your bank from the list.' });
      expect((await put(t[u], { ...coachDetails, personalAccountName: 'Bank Coach 3' })).body.details.fields)
        .toEqual({ personalAccountName: 'The bank account name must not contain numbers. Write the name exactly as on the account.' });
      for (const f of ['personalAccountName', 'personalBankName', 'personalAccountNumber']) {
        const r = await put(t[u], { ...coachDetails, [f]: undefined });
        expect([f, r.status, Object.keys(r.body.details.fields)]).toEqual([f, 400, [f]]);
      }
      // Still held while a personal field is missing.
      expect((await get('/programmes', t[u])).body.code).toBe('BANKING_DETAILS_REQUIRED');
      const ok = await put(t[u], { ...coachDetails, personalAccountNumber: '123456' });   // the 12-digit rule is the teachers' only
      expect([ok.status, ok.body.status, ok.body.missing]).toEqual([200, 'COMPLETE', []]);
      expect((await get('/me', t[u])).body.bankingRequired).toBe(false);
      expect((await get('/programmes', t[u])).status).toBe(200);
      // No school details were asked or stored.
      const row = await ctx.prisma.userBankDetails.findUniqueOrThrow({ where: { userId: ids[u] } });
      expect([row.schoolAccountName, row.schoolBankName, row.schoolAccountNumber]).toEqual([null, null, null]);
    });

    it('school fields sent by a coach are ignored: never checked, never saved', async () => {
      const r = await put(t['bank.coach'], { ...coachDetails, schoolAccountName: 'X', schoolBankName: 'Not a bank', schoolAccountNumber: '' });
      expect([r.status, r.body.status]).toEqual([200, 'COMPLETE']);
      const row = await ctx.prisma.userBankDetails.findUniqueOrThrow({ where: { userId: ids['bank.coach'] } });
      expect([row.schoolAccountName, row.schoolBankName, row.schoolAccountNumber]).toEqual([null, null, null]);
    });

    it('details saved in part are kept and shown; only the missing personal field is asked', async () => {
      const r = await get('/me/banking', t['bank.partial']);
      expect(r.body).toMatchObject({ status: 'PARTIAL', details: { personalAccountName: 'Partial Person', personalBankName: 'Ecobank Rwanda Plc' } });
      expect(r.body.missing).toEqual(['personalAccountNumber']);
    });
  });

  describe('details saved earlier that conflict with the rules: shown, never replaced without the user\'s confirmation', () => {
    it('teacher: both conflicting banks are reported with their saved values; the account is held at the step', async () => {
      const r = await get('/me/banking', t['bank.legacy.t']);
      expect(r.body).toMatchObject({
        status: 'NEEDS_CORRECTION', invalid: ['personalBankName', 'schoolBankName'],
        conflicts: [{ field: 'personalBankName', saved: 'Bank of Kigali Plc' }, { field: 'schoolBankName', saved: 'Equity Bank Rwanda Plc' }],
        details: { personalBankName: 'Bank of Kigali Plc', schoolBankName: 'Equity Bank Rwanda Plc', personalAccountName: 'Legacy Teacher' },
      });
      expect((await get('/notifications', t['bank.legacy.t'])).body.code).toBe('BANKING_DETAILS_REQUIRED');
    });

    it('teacher: without confirmation nothing is replaced — each field named with its saved bank; one confirmation is not enough', async () => {
      const body = { personalAccountName: 'Legacy Teacher', personalAccountNumber: '123456789012', schoolAccountName: 'GS Legacy', schoolAccountNumber: '400100001111' };
      const none = await put(t['bank.legacy.t'], body);
      expect([none.status, none.body.code]).toEqual([400, 'BANKING_INVALID']);
      expect(none.body.details.confirmationNeeded).toEqual(['personalBankName', 'schoolBankName']);
      expect(none.body.details.fields.personalBankName).toContain('Bank of Kigali Plc');
      expect(none.body.details.fields.schoolBankName).toContain('Equity Bank Rwanda Plc');
      const one = await put(t['bank.legacy.t'], { ...body, confirmReplace: ['personalBankName'] });
      expect([one.status, one.body.details.confirmationNeeded]).toEqual([400, ['schoolBankName']]);
      const row = await ctx.prisma.userBankDetails.findUniqueOrThrow({ where: { userId: ids['bank.legacy.t'] } });
      expect([row.personalBankName, row.schoolBankName]).toEqual(['Bank of Kigali Plc', 'Equity Bank Rwanda Plc']);
    });

    it('teacher: confirmed for both, Umwalimu SACCO replaces them; every other saved value is kept; the step ends', async () => {
      const r = await put(t['bank.legacy.t'], {
        personalAccountName: 'Legacy Teacher', personalAccountNumber: '123456789012', schoolAccountName: 'GS Legacy', schoolAccountNumber: '400100001111',
        confirmReplace: ['personalBankName', 'schoolBankName'],
      });
      expect([r.status, r.body.status]).toEqual([200, 'COMPLETE']);
      const row = await ctx.prisma.userBankDetails.findUniqueOrThrow({ where: { userId: ids['bank.legacy.t'] } });
      expect(row).toMatchObject({
        personalAccountName: 'Legacy Teacher', personalBankName: SACCO, personalAccountNumber: '123456789012',
        schoolAccountName: 'GS Legacy', schoolBankName: SACCO, schoolAccountNumber: '400100001111',
      });
      expect((await get('/notifications', t['bank.legacy.t'])).status).toBe(200);
    });

    it('coach with a saved school bank (any bank): complete, no conflict, no confirmation, never held at the step', async () => {
      const form = await get('/me/banking', t['bank.legacy.c']);
      expect(form.body).toMatchObject({ status: 'COMPLETE', missing: [], invalid: [], conflicts: [] });
      expect((await get('/me', t['bank.legacy.c'])).body.bankingRequired).toBe(false);
      expect((await get('/notifications', t['bank.legacy.c'])).status).toBe(200);
      // Saving the personal fields again: no confirmation asked; the saved school details are kept exactly.
      const ok = await put(t['bank.legacy.c'], { personalAccountName: 'Legacy Coach', personalBankName: 'Bank of Kigali Plc', personalAccountNumber: '009988' });
      expect([ok.status, ok.body.status]).toEqual([200, 'COMPLETE']);
      const row = await ctx.prisma.userBankDetails.findUniqueOrThrow({ where: { userId: ids['bank.legacy.c'] } });
      expect(row).toMatchObject({
        personalAccountName: 'Legacy Coach', personalBankName: 'Bank of Kigali Plc', personalAccountNumber: '009988',
        schoolAccountName: 'GS Legacy C', schoolBankName: 'Bank of Kigali Plc', schoolAccountNumber: '4002222',
      });
    });

    it('head coach with saved school details and a missing personal number: held for the personal number only; school details kept', async () => {
      const form = await get('/me/banking', t['bank.legacy.hc']);
      expect(form.body).toMatchObject({ status: 'PARTIAL', missing: ['personalAccountNumber'], invalid: [], conflicts: [] });
      expect((await get('/notifications', t['bank.legacy.hc'])).body.code).toBe('BANKING_DETAILS_REQUIRED');
      const ok = await put(t['bank.legacy.hc'], { personalAccountName: 'Legacy HC', personalBankName: 'Access Bank Rwanda Plc', personalAccountNumber: '77001' });
      expect([ok.status, ok.body.status]).toEqual([200, 'COMPLETE']);
      expect((await get('/notifications', t['bank.legacy.hc'])).status).toBe(200);
      const row = await ctx.prisma.userBankDetails.findUniqueOrThrow({ where: { userId: ids['bank.legacy.hc'] } });
      expect(row).toMatchObject({ personalAccountNumber: '77001', schoolAccountName: 'GS Legacy HC', schoolBankName: 'Equity Bank Rwanda Plc', schoolAccountNumber: '4003333' });
    });
  });

  describe('administrators', () => {
    it('the Users list: status and missing fields per Teacher / Coach / Head Coach, no bank detail; filter by status', async () => {
      const list = await get('/admin/users?limit=100', t.admin);
      expect(list.status).toBe(200);
      const row = (u: string) => list.body.data.find((x: { username: string }) => x.username === u);
      expect(row('bank.teacher').banking).toEqual({ status: 'COMPLETE', missing: [], invalid: [] });
      expect(row('bank.teacher2').banking.status).toBe('NOT_STARTED');
      expect(row('bank.partial').banking).toMatchObject({ status: 'PARTIAL', missing: ['personalAccountNumber'] });
      expect(row('student.j').banking).toBeUndefined();
      expect(JSON.stringify(list.body)).not.toMatch(/123456789012|400100004567|00012345678|bankDetails/);

      const incomplete = await get('/admin/users?limit=100&role=TEACHER&banking=INCOMPLETE', t.admin);
      expect(incomplete.body.data.map((u: { username: string }) => u.username)).toEqual(['bank.teacher2']);
      const complete = await get('/admin/users?limit=100&role=MENTOR&banking=COMPLETE', t.admin);
      expect(complete.body.data.map((u: { username: string }) => u.username)).toContain('bank.coach');
      expect(complete.body.data.map((u: { username: string }) => u.username)).not.toContain('bank.partial');
    });

    it('one person: masked numbers; in full only on request, audited', async () => {
      const masked = await get(`/admin/users/${ids['bank.teacher']}/banking`, t.admin);
      expect(masked.body).toMatchObject({ status: 'COMPLETE', details: { personalAccountNumber: '•••• 9012', schoolAccountNumber: '•••• 4567', revealed: false } });
      expect(await ctx.prisma.auditLog.count({ where: { action: 'BANK_DETAILS_VIEWED' } })).toBe(0);
      const full = await get(`/admin/users/${ids['bank.teacher']}/banking?reveal=true`, t.admin);
      expect(full.body.details).toMatchObject({ personalAccountNumber: '123456789012', revealed: true });
      expect(await ctx.prisma.auditLog.count({ where: { action: 'BANK_DETAILS_VIEWED', entityId: ids['bank.teacher'] } })).toBe(1);
      const partial = await get(`/admin/users/${ids['bank.partial']}/banking`, t.admin);
      expect(partial.body.missingLabels).toEqual(['Bank account number']);
      // The fields each role gives: six for a Teacher, three personal ones for a Coach or Head Coach.
      expect(masked.body.requiredFields).toHaveLength(6);
      expect(partial.body.requiredFields).toEqual(['personalAccountName', 'personalBankName', 'personalAccountNumber']);
      // A coach's legacy school details are still shown to administrators, masked.
      const legacy = await get(`/admin/users/${ids['bank.legacy.c']}/banking`, t.admin);
      expect(legacy.body).toMatchObject({ status: 'COMPLETE', details: { schoolAccountName: 'GS Legacy C', schoolAccountNumber: '•••• 2222' } });
    });

    it('nobody else reaches another person\'s details', async () => {
      for (const who of ['bank.teacher', 'mentor', 'student']) {
        const r = await get(`/admin/users/${ids['bank.coach']}/banking`, t[who]);
        expect([who, r.status]).toEqual([who, 403]);
      }
    });

    it('a bulk action never uses the banking filter', async () => {
      const r = await http().post('/api/v1/admin/users/bulk/preview').set(bearer(t.admin))
        .send({ action: 'message', params: { subject: 'Hi', body: 'Hello' }, selection: { mode: 'filter', filter: { role: 'TEACHER', banking: 'INCOMPLETE' } } });
      // Refused: the bulk filter does not accept `banking` (VALIDATION_FAILED); the engine refuses it too (BULK_BANKING_FILTER).
      expect(r.status).toBe(400);
      expect(['VALIDATION_FAILED', 'BULK_BANKING_FILTER']).toContain(r.body.code);
      expect(JSON.stringify(r.body)).toMatch(/banking/i);
    });
  });
});
