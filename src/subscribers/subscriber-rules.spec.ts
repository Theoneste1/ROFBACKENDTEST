import {
  audienceWhere, greetingFor, listUnsubscribeHeaders, looksLikeEmail, normaliseAudience, normaliseEmail, unsubscribeLinks,
  unsubscribeToken, verifyUnsubscribeToken,
} from './subscriber-rules.js';
import { mergeInterests } from './subscribers.service.js';
import { mailingStatus } from './mailings.service.js';
import { renderEmail, SUBSCRIBED_BECAUSE } from '../email/templates.js';

const SECRET = 'unit-test-secret-that-is-long-enough-0123456789';
const ID = '6f1c2a8e-2b1d-4a7e-9c55-0d6f0f6b9a10';

describe('subscriber rules', () => {
  describe('normaliseEmail / looksLikeEmail', () => {
    it('trims and lower-cases; the same address always gives the same key', () => {
      expect(normaliseEmail('  Ada.Lovelace@Example.ORG ')).toBe('ada.lovelace@example.org');
      expect(normaliseEmail('ADA@EXAMPLE.ORG')).toBe(normaliseEmail('ada@example.org'));
    });
    it('uses one Unicode form (composed and decomposed accents are the same address)', () => {
      expect(normaliseEmail('josé@example.org')).toBe(normaliseEmail('josé@example.org'));
    });
    it('accepts ordinary addresses and refuses obvious mistakes', () => {
      expect(looksLikeEmail('a.b+news@school.ac.rw')).toBe(true);
      for (const bad of ['', 'no-at-sign', 'two@@example.org', 'space in@example.org', 'nodot@example', `${'a'.repeat(250)}@x.rw`]) {
        expect([bad, looksLikeEmail(bad)]).toEqual([bad, false]);
      }
    });
  });

  describe('unsubscribe token', () => {
    it('is an HMAC of the id: stable, url-safe, different per subscriber and per secret', () => {
      const t = unsubscribeToken(SECRET, ID);
      expect(t).toBe(unsubscribeToken(SECRET, ID));
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(unsubscribeToken(SECRET, `${ID.slice(0, -1)}1`)).not.toBe(t);
      expect(unsubscribeToken(`${SECRET}x`, ID)).not.toBe(t);
    });
    it('verifies only the exact token for that subscriber', () => {
      const t = unsubscribeToken(SECRET, ID);
      expect(verifyUnsubscribeToken(SECRET, ID, t)).toBe(true);
      expect(verifyUnsubscribeToken(SECRET, ID, `${t.slice(0, -1)}${t.endsWith('A') ? 'B' : 'A'}`)).toBe(false);
      expect(verifyUnsubscribeToken(SECRET, ID, t.slice(1))).toBe(false);
      expect(verifyUnsubscribeToken(SECRET, 'another-id', t)).toBe(false);
      expect(verifyUnsubscribeToken('other-secret-that-is-long-enough-0123456789', ID, t)).toBe(false);
      for (const bad of [undefined, null, 42, '', 'x'.repeat(500)]) expect(verifyUnsubscribeToken(SECRET, ID, bad)).toBe(false);
    });
  });

  describe('unsubscribe links and headers', () => {
    it('the page link points to the frontend with s and t; one-click only with the API address', () => {
      const t = unsubscribeToken(SECRET, ID);
      const page = unsubscribeLinks({ secret: SECRET, appUrl: 'https://lms.example.org/' }, ID);
      expect(page).toEqual({ pageUrl: `https://lms.example.org/unsubscribe?s=${ID}&t=${t}`, oneClickUrl: null });
      const both = unsubscribeLinks({ secret: SECRET, appUrl: 'https://lms.example.org', apiPublicUrl: 'https://api.example.org' }, ID);
      expect(both.oneClickUrl).toBe(`https://api.example.org/api/v1/public/unsubscribe/one-click?s=${ID}&t=${t}`);
      expect(unsubscribeLinks({ secret: SECRET, appUrl: null }, ID)).toEqual({ pageUrl: null, oneClickUrl: null });
      expect(unsubscribeLinks({ secret: SECRET, appUrl: 'javascript:alert(1)' }, ID).pageUrl).toBeNull();
    });
    it('RFC 8058: List-Unsubscribe-Post only with an https one-click target; otherwise the page link alone', () => {
      expect(listUnsubscribeHeaders({ pageUrl: 'https://a/unsubscribe?s=1', oneClickUrl: 'https://api/x' })).toEqual({
        'List-Unsubscribe': '<https://api/x>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      });
      expect(listUnsubscribeHeaders({ pageUrl: 'https://a/unsubscribe?s=1', oneClickUrl: 'http://api/x' })).toEqual({ 'List-Unsubscribe': '<https://a/unsubscribe?s=1>' });
      expect(listUnsubscribeHeaders({ pageUrl: null, oneClickUrl: null })).toEqual({});
    });
    it('every subscriber e-mail shows the link in its text and HTML footer', () => {
      const url = 'https://lms.example.org/unsubscribe?s=1&t=2';
      const mail = renderEmail({ heading: 'News', body: 'Hello there.', unsubscribeUrl: url }, { organization: 'ROF', contactEmail: null, appUrl: null });
      expect(mail.text).toContain(`${SUBSCRIBED_BECAUSE} Unsubscribe: ${url}`);
      expect(mail.html).toContain('href="https://lms.example.org/unsubscribe?s=1&amp;t=2"');
      const plain = renderEmail({ body: 'x' }, { organization: 'ROF', contactEmail: null, appUrl: null });
      expect(plain.text).not.toContain('Unsubscribe');
      expect(plain.html).not.toContain('Unsubscribe');
    });
  });

  describe('audience', () => {
    it('normalises: empty lists dropped, values unique and sorted, countries upper-case', () => {
      expect(normaliseAudience(undefined)).toEqual({});
      expect(normaliseAudience({ interests: [], kinds: [], countries: [' '] })).toEqual({});
      expect(normaliseAudience({ interests: ['PHYSICS', 'MATHEMATICS', 'PHYSICS'], kinds: ['SCHOOL', 'PARENT'], countries: ['rw', 'KE', 'RW'] }))
        .toEqual({ interests: ['MATHEMATICS', 'PHYSICS'], kinds: ['PARENT', 'SCHOOL'], countries: ['KE', 'RW'] });
    });
    it('always ACTIVE only; interests match any of them or "no interest" (= every subject); kinds and countries are lists', () => {
      expect(audienceWhere({})).toEqual({ AND: [{ status: 'ACTIVE' }] });
      expect(audienceWhere({ interests: ['MATHEMATICS'], kinds: ['PARENT'], countries: ['RW'] })).toEqual({ AND: [
        { status: 'ACTIVE' },
        { OR: [{ interests: { hasSome: ['MATHEMATICS'] } }, { interests: { isEmpty: true } }] },
        { kind: { in: ['PARENT'] } },
        { country: { in: ['RW'] } },
      ] });
    });
  });

  it('merges interests of someone already subscribed: none on either side means every subject', () => {
    expect(mergeInterests(['PHYSICS'], undefined)).toEqual(['PHYSICS']);
    expect(mergeInterests(['PHYSICS'], ['MATHEMATICS', 'PHYSICS'])).toEqual(['MATHEMATICS', 'PHYSICS']);
    expect(mergeInterests([], ['PHYSICS'])).toEqual([]);
    expect(mergeInterests(['PHYSICS'], [])).toEqual([]);
  });

  it('greets by first name, or plainly', () => {
    expect(greetingFor('Ada  Lovelace')).toBe('Hello Ada,');
    expect(greetingFor('  ')).toBe('Hello,');
    expect(greetingFor(null)).toBe('Hello,');
  });

  it('mailing status from its deliveries', () => {
    expect(mailingStatus('QUEUED', { pending: 3, sent: 0, failed: 0 })).toBe('QUEUED');
    expect(mailingStatus('QUEUED', { pending: 2, sent: 1, failed: 0 })).toBe('SENDING');
    expect(mailingStatus('SENDING', { pending: 0, sent: 2, failed: 1 })).toBe('SENT');
    expect(mailingStatus('SENDING', { pending: 0, sent: 0, failed: 3 })).toBe('FAILED');
    expect(mailingStatus('CANCELLED', { pending: 0, sent: 1, failed: 0 })).toBe('CANCELLED');
  });
});
