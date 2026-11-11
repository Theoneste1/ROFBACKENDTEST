import { maskContact, normaliseContact, normalisePhone, redactContactText } from './school-contacts.js';

describe('school contacts — normalisation (S1)', () => {
  it('e-mail: trimmed and lower-cased; anything else refused', () => {
    expect(normaliseContact('EMAIL', '  GS.Kigali@Mineduc.GOV.rw ')).toEqual({ value: 'gs.kigali@mineduc.gov.rw' });
    for (const bad of ['N/A', 'gs kigali@x.rw', 'gs@kigali', '@x.rw']) expect(normaliseContact('EMAIL', bad)).toHaveProperty('problem');
  });

  it('phone: Rwandan numbers in every common local form become +250…', () => {
    for (const raw of ['0788123456', '078 812 3456', '0788-123-456', '(0788) 123456', '788123456', '250788123456', '+250 788 123 456', '00250788123456']) {
      expect([raw, normalisePhone(raw)]).toEqual([raw, '+250788123456']);
    }
    expect(normalisePhone('0252123456')).toBe('+250252123456');   // landline
  });

  it('phone: other countries in international form; source quirks refused', () => {
    expect(normalisePhone('+254 712 345678')).toBe('+254712345678');
    for (const bad of ['N/A', 'No Primary', '07881234O6', '0588123456', '+25078812345', '12345', '+0123456789']) {
      expect([bad, normalisePhone(bad)]).toEqual([bad, null]);
    }
  });

  it('masking (audit entries): never the value — e-mail initials and top-level domain, phone country code and last two digits', () => {
    expect(maskContact('EMAIL', 'head@gs-contact.rw')).toBe('h•••@g•••.rw');
    expect(maskContact('EMAIL', 'odd')).toBe('o•••@•••');
    expect(maskContact('PHONE', '+250788123456')).toBe('+250•••56');
    expect(maskContact('PHONE', '+254712345678')).toBe('+254•••78');
    expect(maskContact('OTHER', 'P.O. Box 123, Huye')).toBe('P•••');
    for (const [type, value] of [['EMAIL', 'head@gs-contact.rw'], ['PHONE', '+250788123456']] as const) {
      const masked = maskContact(type, value);
      expect(masked).not.toContain(value);
      expect(masked.replace(/\D/g, '').length).toBeLessThanOrEqual(5);   // country code + 2 digits at most
    }
  });

  it('reasons on contact changes: e-mail addresses and phone numbers masked, the rest kept; dates and codes untouched', () => {
    expect(redactContactText('Called Head.Teacher@Example-School.rw on 0788 555 123, confirmed by +250 722 999 888.')).toEqual({
      text: 'Called h•••@e•••.rw on +250•••23, confirmed by +250•••88.', redacted: true,
    });
    expect(redactContactText('Number from the NESA list: (0788) 555-123')).toEqual({ text: 'Number from the NESA list: (+250•••23', redacted: true });
    expect(redactContactText('Kenyan office +254 712 345 678')).toEqual({ text: 'Kenyan office +254•••78', redacted: true });
    for (const plain of ['Checked with NESA on 2026-11-11', 'School code 220001 confirmed', 'Called the head teacher', 'Ticket 12345678']) {
      expect(redactContactText(plain)).toEqual({ text: plain, redacted: false });
    }
    const out = redactContactText('head@gs.rw 0788123456 250788123456 +250788123456').text;
    for (const leaked of ['head@gs.rw', '788123456']) expect(out).not.toContain(leaked);
  });

  it('other: free text, whitespace collapsed; empty refused', () => {
    expect(normaliseContact('OTHER', '  P.O. Box   123,  Huye ')).toEqual({ value: 'P.O. Box 123, Huye' });
    expect(normaliseContact('OTHER', '   ')).toHaveProperty('problem');
  });
});
