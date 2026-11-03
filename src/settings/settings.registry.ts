/**
 * The complete list of system settings an administrator can change.
 *
 * Only keys declared here can be read or written; values are validated
 * against the declared type before they are stored.
 */
export type SettingType = 'boolean' | 'string' | 'enum';

export interface SettingDefinition {
  type:        SettingType;
  default:     unknown;
  description: string;
  options?:    readonly string[];
  nullable?:   boolean;
  maxLength?:  number;
}

export const SETTINGS = {
  'registration.studentSelfSignup': {
    type:        'boolean',
    default:     true,
    description: 'Allow students to create their own accounts.',
  },
  'registration.studentRequiresApproval': {
    type:        'boolean',
    default:     false,
    description: 'Self-registered students must be approved by an admin before they can log in.',
  },
  'registration.requireEmailVerification': {
    type:        'boolean',
    default:     false,
    description: 'Self-registered students must confirm their e-mail address before they can log in.',
  },
  'notifications.emailEnabled': {
    type:        'boolean',
    default:     true,
    description: 'Send e-mail copies of notifications (account e-mails are always sent).',
  },
  'leaderboard.visibleToStudents': {
    type:        'boolean',
    default:     true,
    description: 'Show the division leaderboard to students.',
  },
  'submissions.defaultDistributionStrategy': {
    type:        'enum',
    options:     ['BALANCED', 'ROUND_ROBIN'],
    default:     'BALANCED',
    description: 'How submissions are spread across mentors when no strategy is given.',
  },
  'platform.name': {
    type:        'string',
    default:     'ROF Learning Platform',
    maxLength:   100,
    description: 'Name used in e-mails.',
  },
  'platform.supportEmail': {
    type:        'string',
    default:     null,
    nullable:    true,
    maxLength:   200,
    description: 'Contact address shown in e-mails.',
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTINGS;

export type SettingValue<K extends SettingKey> =
  (typeof SETTINGS)[K]['type'] extends 'boolean' ? boolean :
  (typeof SETTINGS)[K] extends { options: readonly (infer O)[] } ? O :
  (typeof SETTINGS)[K] extends { nullable: true } ? string | null :
  string;

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

/** Returns an error message, or null when the value is acceptable. */
export function validateSettingValue(key: SettingKey, value: unknown): string | null {
  const def: SettingDefinition = SETTINGS[key];
  if (value === null) return def.nullable ? null : `${key} cannot be null.`;
  switch (def.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : `${key} must be true or false.`;
    case 'enum':
      return def.options!.includes(value as string)
        ? null
        : `${key} must be one of: ${def.options!.join(', ')}.`;
    case 'string':
      if (typeof value !== 'string') return `${key} must be text.`;
      if (def.maxLength && value.length > def.maxLength) return `${key} is too long (max ${def.maxLength}).`;
      return null;
  }
}
