/**
 * Olympiad interests of students (owner decision 8): Mathematics, Computing, Physics — several at once.
 * Accepted at registration (optional for older clients), shown and edited on the profile, shown in the
 * admin user detail, the students report and students.csv. Never tied to programme membership or
 * permissions.
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

describe('Olympiad interests (e2e)', () => {
  let ctx: TestContext;
  let admin: string;
  const http = () => ctx.http();

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    await ctx.prisma.school.create({ data: {
      name: 'GS INTERESTS', location: 'Huye', code: '310999', district: 'Huye', sector: 'Ngoma', ownership: 'PUBLIC', nameKey: 'gs interests',
    } });
  });
  afterAll(async () => { await ctx?.app.close(); });

  let n = 0;
  const register = (body: Record<string, unknown> = {}) => {
    n += 1;
    return http().post('/api/v1/auth/register/student').send({
      firstName: 'Ines', lastName: 'Interest', username: `oi.s${n}`, email: `oi.s${n}@example.com`,
      password: 'Secret123', dateOfBirth: '2010-05-01', gender: 'FEMALE', guardianPhone: '0722000111', gradeLevel: 'S3', schoolCode: '310999', homeLocation: 'Huye', ...body,
    });
  };
  const userOf = (username: string) => ctx.prisma.user.findUniqueOrThrow({ where: { username } });

  it('registration stores several interests in the fixed order and returns them; the audit entry records them', async () => {
    const res = await register({ olympiadInterests: ['PHYSICS', 'MATHEMATICS'] }).expect(201);
    expect(res.body.olympiadInterests).toEqual(['MATHEMATICS', 'PHYSICS']);
    const user = await userOf(res.body.username);
    expect(user.olympiadInterests).toEqual(['MATHEMATICS', 'PHYSICS']);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'REGISTER', entityId: user.id } });
    expect(audit.metadata).toMatchObject({ olympiadInterests: ['MATHEMATICS', 'PHYSICS'] });
    const all = await register({ olympiadInterests: ['COMPUTING', 'PHYSICS', 'MATHEMATICS'] }).expect(201);
    expect(all.body.olympiadInterests).toEqual(['MATHEMATICS', 'COMPUTING', 'PHYSICS']);
  });

  it('older clients (no field): registered as before, with no interests', async () => {
    const res = await register().expect(201);
    expect(res.body.olympiadInterests).toEqual([]);
    expect((await userOf(res.body.username)).olympiadInterests).toEqual([]);
  });

  it('only Mathematics, Computing and Physics; at least one when sent; no duplicates; nothing created when refused', async () => {
    for (const bad of [[], ['CHEMISTRY'], ['MATHEMATICS', 'MATHEMATICS'], 'MATHEMATICS', ['mathematics'], [null]]) {
      const username = `oi.bad${++n}`;
      const res = await register({ username, email: `${username}@example.com`, olympiadInterests: bad }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await ctx.prisma.user.count({ where: { username } })).toBe(0);
    }
  });

  it('interests are not programme membership: the same membership with or without them; no permission change', async () => {
    const withIt = await register({ olympiadInterests: ['COMPUTING', 'PHYSICS'] }).expect(201);
    const without = await register().expect(201);
    const programmesOf = async (id: string) => (await ctx.prisma.programmeMembership.findMany({
      where: { userId: id, isActive: true }, select: { disciplineId: true, source: true },
    })).map((m) => `${m.disciplineId}:${m.source}`).sort();
    expect((await programmesOf(withIt.body.id)).length).toBeGreaterThan(0);
    expect(await programmesOf(withIt.body.id)).toEqual(await programmesOf(without.body.id));
    const tokenA = await login(ctx, withIt.body.username, 'Secret123');
    const tokenB = await login(ctx, without.body.username, 'Secret123');
    const permsA = (await http().get('/api/v1/me/permissions').set(bearer(tokenA)).expect(200)).body;
    const permsB = (await http().get('/api/v1/me/permissions').set(bearer(tokenB)).expect(200)).body;
    expect(permsA.permissions).toEqual(permsB.permissions);
  });

  it('the profile shows them and PATCH /me replaces them (validated); other fields untouched', async () => {
    const res = await register({ olympiadInterests: ['MATHEMATICS'] }).expect(201);
    const token = await login(ctx, res.body.username, 'Secret123');
    expect((await http().get('/api/v1/me').set(bearer(token)).expect(200)).body.olympiadInterests).toEqual(['MATHEMATICS']);
    const updated = await http().patch('/api/v1/me').set(bearer(token)).send({ olympiadInterests: ['PHYSICS', 'COMPUTING'] }).expect(200);
    expect(updated.body).toMatchObject({ olympiadInterests: ['COMPUTING', 'PHYSICS'], firstName: 'Ines', homeLocation: 'Huye' });
    expect((await http().get('/api/v1/me').set(bearer(token)).expect(200)).body.olympiadInterests).toEqual(['COMPUTING', 'PHYSICS']);
    for (const bad of [[], ['BIOLOGY'], ['PHYSICS', 'PHYSICS']]) {
      expect((await http().patch('/api/v1/me').set(bearer(token)).send({ olympiadInterests: bad }).expect(400)).body.code).toBe('VALIDATION_FAILED');
    }
    // Another field alone keeps them.
    await http().patch('/api/v1/me').set(bearer(token)).send({ homeLocation: 'Kigali' }).expect(200);
    expect((await userOf(res.body.username)).olympiadInterests).toEqual(['COMPUTING', 'PHYSICS']);
  });

  it('administrators see them in the user detail, the students report and students.csv', async () => {
    const res = await register({ firstName: 'Zed', lastName: 'Zulu', olympiadInterests: ['COMPUTING', 'MATHEMATICS'] }).expect(201);
    const detail = await http().get(`/api/v1/admin/users/${res.body.id}`).set(bearer(admin)).expect(200);
    expect(detail.body.olympiadInterests).toEqual(['MATHEMATICS', 'COMPUTING']);

    const report = await http().get('/api/v1/admin/reports/students').query({ q: res.body.username }).set(bearer(admin)).expect(200);
    expect(report.body.data).toHaveLength(1);
    expect(report.body.data[0].olympiadInterests).toEqual(['MATHEMATICS', 'COMPUTING']);

    const csv = await http().get('/api/v1/admin/reports/students.csv').query({ q: res.body.username }).set(bearer(admin)).expect(200);
    const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0].endsWith(',Last login,Olympiad interests')).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith(',Mathematics; Computing')).toBe(true);
  });
});
