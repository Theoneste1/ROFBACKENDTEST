import { CONFIGURABLE_NOTIFICATION_TYPES, configurableTypesFor } from './notification-types.js';
import { Events } from './events.js';

describe('configurable notification types', () => {
  it('lists real event types, each once', () => {
    const types = CONFIGURABLE_NOTIFICATION_TYPES.map((t) => t.type);
    const events = new Set<string>(Object.values(Events));
    for (const type of types) expect(events.has(type), type).toBe(true);
    expect(new Set(types).size).toBe(types.length);
  });

  it('are only for administrators and mentors', () => {
    expect(configurableTypesFor('STUDENT')).toEqual([]);
    expect(configurableTypesFor('ADMIN').length).toBeGreaterThan(0);
    expect(configurableTypesFor('MENTOR').length).toBeGreaterThan(0);
  });
});
