/**
 * Directory reference data seeded by M12 (school directory S1). The same values are used by the
 * development seed and the test suite, which truncates every table.
 */
export const EDUCATION_LEVELS = [
  { code: 'PPR', name: 'Pre-primary', sortOrder: 1 },
  { code: 'PR',  name: 'Primary', sortOrder: 2 },
  { code: 'OL',  name: 'Ordinary Level', sortOrder: 3 },
  { code: 'AL',  name: 'Advanced Level', sortOrder: 4 },
  { code: 'PE',  name: 'Professional Education', sortOrder: 5 },
] as const;

export const NESA_DATA_SOURCE = {
  key: 'NESA',
  name: 'National Examination and School Inspection Authority (NESA)',
  url: 'https://ireme.nesa.gov.rw',
  description: 'Accredited-schools exports of the Rwanda school directory.',
} as const;
