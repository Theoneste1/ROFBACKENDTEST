import { maskContacts, maskPhone } from './contact-masking.js';

describe('contact masking (lists)', () => {
  it('keeps the country code and the last three digits', () => {
    expect(maskPhone('+250788123456')).toBe('+250••••••456');
    expect(maskPhone('+254712345678')).toBe('+•••••••••678');
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone('')).toBeNull();
    expect(maskPhone('123')).toBe('•••');
  });
  it('never returns the full number', () => {
    for (const p of ['+250788123456', '+12025550123', '+447700900123']) expect(maskPhone(p)).not.toContain(p.slice(4, -3));
  });
  it('masks only the phone fields of a row', () => {
    expect(maskContacts({ id: 'u', phone: '+250788123456', guardianPhone: '+250722000111', email: 'a@b.c' }))
      .toEqual({ id: 'u', phone: '+250••••••456', guardianPhone: '+250••••••111', email: 'a@b.c' });
    expect(maskContacts({ id: 'u' } as { id: string; phone?: string })).toEqual({ id: 'u' });
  });
});
