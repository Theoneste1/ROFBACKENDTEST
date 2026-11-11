import { normaliseContact, normalisePhone } from './school-contacts.js';

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

  it('other: free text, whitespace collapsed; empty refused', () => {
    expect(normaliseContact('OTHER', '  P.O. Box   123,  Huye ')).toEqual({ value: 'P.O. Box 123, Huye' });
    expect(normaliseContact('OTHER', '   ')).toHaveProperty('problem');
  });
});
