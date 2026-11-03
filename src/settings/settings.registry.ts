/**
 * The complete list of system settings an administrator can change.
 *
 * Only keys declared here can be read or written; values are validated
 * against the declared type (and limits) before they are stored. Settings are
 * grouped by `category` for the settings screen.
 *
 * The academic years themselves (dates, which one is current) are managed by
 * the academic-year endpoints, not stored here.
 */
export type SettingType = 'boolean' | 'string' | 'enum' | 'integer' | 'email' | 'url';

export type SettingCategory = 'REGISTRATION' | 'ASSIGNMENTS' | 'NOTIFICATIONS' | 'LIVE_SESSIONS' | 'PLATFORM' | 'SUPPORT';

export interface SettingDefinition {
  category:    SettingCategory;
  type:        SettingType;
  default:     unknown;
  description: string;
  options?:    readonly string[];
  nullable?:   boolean;
  maxLength?:  number;
  min?:        number;
  max?:        number;
  unit?:       string;
}

export const SETTINGS = {
  // ── Registration ───────────────────────────────────────────────────────────
  'registration.studentSelfSignup': {
    category:    'REGISTRATION',
    type:        'boolean',
    default:     true,
    description: 'Allow students to create their own accounts.',
  },
  'registration.studentRequiresApproval': {
    category:    'REGISTRATION',
    type:        'boolean',
    default:     false,
    description: 'Self-registered students must be approved by an admin before they can log in.',
  },
  'registration.requireEmailVerification': {
    category:    'REGISTRATION',
    type:        'boolean',
    default:     false,
    description: 'Self-registered students must confirm their e-mail address before they can log in.',
  },

  // ── Assignments and submissions ────────────────────────────────────────────
  'assignments.defaultAllowResubmission': {
    category:    'ASSIGNMENTS',
    type:        'boolean',
    default:     false,
    description: 'New assignments let students resubmit, unless the mentor chooses otherwise.',
  },
  'assignments.defaultMaxResubmissions': {
    category:    'ASSIGNMENTS',
    type:        'integer',
    default:     0,
    min:         0,
    max:         10,
    description: 'Default limit on resubmissions for new assignments that allow them (0 = no limit).',
  },
  'assignments.defaultAllowLateSubmission': {
    category:    'ASSIGNMENTS',
    type:        'boolean',
    default:     false,
    description: 'New assignments accept late first submissions (flagged late), unless the mentor chooses otherwise.',
  },
  'submissions.resubmissionRequestDays': {
    category:    'ASSIGNMENTS',
    type:        'integer',
    default:     7,
    min:         1,
    max:         60,
    unit:        'days',
    description: 'When a mentor asks for a resubmission without a due date, the student gets this long (or until the deadline, if later).',
  },
  'submissions.defaultDistributionStrategy': {
    category:    'ASSIGNMENTS',
    type:        'enum',
    options:     ['BALANCED', 'ROUND_ROBIN'],
    default:     'BALANCED',
    description: 'How submissions are spread across mentors when no strategy is given.',
  },

  // ── Notification rules ─────────────────────────────────────────────────────
  'notifications.emailEnabled': {
    category:    'NOTIFICATIONS',
    type:        'boolean',
    default:     true,
    description: 'Send e-mail copies of notifications (account e-mails are always sent).',
  },
  'notifications.deadlineRemindersEnabled': {
    category:    'NOTIFICATIONS',
    type:        'boolean',
    default:     true,
    description: 'Remind students who have not submitted that an assignment is due soon.',
  },
  'notifications.deadlineReminderHours': {
    category:    'NOTIFICATIONS',
    type:        'integer',
    default:     24,
    min:         1,
    max:         168,
    unit:        'hours',
    description: 'How long before the deadline the "due soon" reminder is sent.',
  },
  'notifications.liveSessionRemindersEnabled': {
    category:    'NOTIFICATIONS',
    type:        'boolean',
    default:     true,
    description: 'Remind students shortly before a live session starts.',
  },
  'notifications.liveSessionReminderMinutes': {
    category:    'NOTIFICATIONS',
    type:        'integer',
    default:     60,
    min:         10,
    max:         1440,
    unit:        'minutes',
    description: 'How long before a live session the "starting soon" reminder is sent.',
  },

  // ── Live sessions ──────────────────────────────────────────────────────────
  'liveSessions.maxDurationHours': {
    category:    'LIVE_SESSIONS',
    type:        'integer',
    default:     8,
    min:         1,
    max:         12,
    unit:        'hours',
    description: 'Longest a live session may be scheduled for.',
  },

  // ── Platform ───────────────────────────────────────────────────────────────
  'leaderboard.visibleToStudents': {
    category:    'PLATFORM',
    type:        'boolean',
    default:     true,
    description: 'Show the division leaderboard to students.',
  },
  'platform.name': {
    category:    'PLATFORM',
    type:        'string',
    default:     'ROF Learning Platform',
    maxLength:   100,
    description: 'Name used in e-mails and on the help page.',
  },

  // ── Help and support ───────────────────────────────────────────────────────
  'platform.supportEmail': {
    category:    'SUPPORT',
    type:        'email',
    default:     null,
    nullable:    true,
    maxLength:   200,
    description: 'Support e-mail address shown on the help page and in e-mails.',
  },
  'support.phone': {
    category:    'SUPPORT',
    type:        'string',
    default:     null,
    nullable:    true,
    maxLength:   40,
    description: 'Support phone number shown on the help page.',
  },
  'support.hours': {
    category:    'SUPPORT',
    type:        'string',
    default:     null,
    nullable:    true,
    maxLength:   200,
    description: 'When support is available, e.g. "Mon–Fri, 08:00–17:00".',
  },
  'support.helpUrl': {
    category:    'SUPPORT',
    type:        'url',
    default:     null,
    nullable:    true,
    maxLength:   500,
    description: 'Link to help pages or a user guide (https).',
  },
  'support.message': {
    category:    'SUPPORT',
    type:        'string',
    default:     null,
    nullable:    true,
    maxLength:   1000,
    description: 'A short note shown on the help page.',
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTINGS;

export type SettingValue<K extends SettingKey> =
  (typeof SETTINGS)[K]['type'] extends 'boolean' ? boolean :
  (typeof SETTINGS)[K]['type'] extends 'integer' ? number :
  (typeof SETTINGS)[K] extends { options: readonly (infer O)[] } ? O :
  (typeof SETTINGS)[K] extends { nullable: true } ? string | null :
  string;

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return `${key} must be a whole number.`;
      if (def.min !== undefined && value < def.min) return `${key} must be at least ${def.min}.`;
      if (def.max !== undefined && value > def.max) return `${key} must be at most ${def.max}.`;
      return null;
    case 'string':
    case 'email':
    case 'url': {
      if (typeof value !== 'string') return `${key} must be text.`;
      if (value.trim() === '') return `${key} cannot be empty (use null to clear it).`;
      if (def.maxLength && value.length > def.maxLength) return `${key} is too long (max ${def.maxLength}).`;
      if (def.type === 'email' && !EMAIL.test(value)) return `${key} must be an e-mail address.`;
      if (def.type === 'url' && !isHttpsUrl(value)) return `${key} must be an https:// link.`;
      return null;
    }
  }
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
