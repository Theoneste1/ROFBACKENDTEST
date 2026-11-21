import { CONFIGURABLE_NOTIFICATION_TYPES, configurableTypesFor } from './notification-types.js';
import { Events } from './events.js';

describe('configurable notification types', () => {
  it('lists real event types, each once', () => {
    const types = CONFIGURABLE_NOTIFICATION_TYPES.map((t) => t.type);
    const events = new Set<string>(Object.values(Events));
    for (const type of types) expect(events.has(type), type).toBe(true);
    expect(new Set(types).size).toBe(types.length);
  });

  it('are only for administrators, Super Administrators, coaches and Head Coaches', () => {
    expect(configurableTypesFor('STUDENT')).toEqual([]);
    expect(configurableTypesFor('TEACHER')).toEqual([]);
    expect(configurableTypesFor('ADMIN').length).toBeGreaterThan(0);
    expect(configurableTypesFor('MENTOR').length).toBeGreaterThan(0);
  });

  it("a Super Administrator has the administrators' switches and a Head Coach the coaches'", () => {
    const types = (r: Parameters<typeof configurableTypesFor>[0]) => configurableTypesFor(r).map((t) => t.type).sort();
    expect(types('SUPER_ADMIN')).toEqual(types('ADMIN'));
    expect(types('HEAD_COACH')).toEqual(types('MENTOR'));
  });
});
