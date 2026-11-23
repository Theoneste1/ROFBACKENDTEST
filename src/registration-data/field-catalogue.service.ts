/**
 * Registration data: the FIELD CATALOGUE, read from the database itself (information_schema and pg_enum), so a column a
 * migration adds later appears without a code change. Each column then passes the eligibility layer (field-policy.ts).
 *
 * A column is offered only when the database AND the application's data model (Prisma) both know it — a column added
 * to the database before the application that understands it is deployed stays out until then.
 */
import { Injectable } from '@nestjs/common';

import { ROLE_LABELS, type AppRole } from '../auth/permissions.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CATEGORIES, eligibility, humanize, SOURCES, STUDENT_ONLY, type CategoryKey, type EditVia, type SourceKey,
} from './field-policy.js';

export type FieldType = 'text' | 'number' | 'date' | 'datetime' | 'boolean' | 'enum' | 'enumList' | 'textList';

export interface Field {
  /** "<source>.<column>", e.g. "user.firstName", "coachApplication.occupation". */
  key: string;
  source: SourceKey;
  column: string;
  label: string;
  group: string;
  type: FieldType;
  /** enum / enumList: the allowed values, and how to show each. */
  values: string[] | null;
  valueLabels: Record<string, string> | null;
  nullable: boolean;
  integer: boolean;
  maxLength: number | null;
  /** How it is edited: 'direct' (this module), 'account' (the account rules), 'status', 'dateOfBirth', 'olympiadLevel', 'none'. */
  editVia: EditVia;
  personal: boolean;
  filterable: boolean;
  sortable: boolean;
  /** A reference shown by the related record's name: "school" (user.schoolId) or "division" (user.divisionId). */
  reference: 'school' | 'division' | null;
}

interface ColumnRow { table_name: string; column_name: string; data_type: string; udt_name: string; is_nullable: string; max_length: number | null; is_fk: boolean }

const CACHE_MS = 60_000;

/** The Prisma scalar fields of a model (the application's data model). */
function prismaScalars(model: string): Set<string> {
  const e = (Prisma as unknown as Record<string, Record<string, string> | undefined>)[`${model}ScalarFieldEnum`];
  return new Set(e ? Object.values(e) : []);
}

/** How an enum value is shown: roles as everywhere else (MENTOR → Coach); others in words (GOVERNMENT_AIDED → Government aided). */
export function enumLabel(type: string, v: string): string {
  if (type === 'Role' && v in ROLE_LABELS) return ROLE_LABELS[v as AppRole];
  return /^[A-Z]\d$/.test(v) ? v : humanize(v.toLowerCase());
}

@Injectable()
export class FieldCatalogueService {
  private cache: { at: number; fields: Field[] } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Forget the cached catalogue (tests; after a migration the process restarts anyway). */
  invalidate() {
    this.cache = null;
  }

  /** Every eligible field of every source. */
  async all(): Promise<Field[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.fields;
    const tables = Object.values(SOURCES).map((s) => s.model);
    const [columns, enums, divisions] = await Promise.all([
      this.prisma.$queryRaw<ColumnRow[]>`
        SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable,
               c.character_maximum_length AS max_length,
               EXISTS (
                 SELECT 1 FROM information_schema.key_column_usage k
                 JOIN information_schema.table_constraints t
                   ON t.constraint_name = k.constraint_name AND t.table_schema = k.table_schema AND t.table_name = k.table_name
                 WHERE t.constraint_type = 'FOREIGN KEY' AND k.table_schema = c.table_schema
                   AND k.table_name = c.table_name AND k.column_name = c.column_name
               ) AS is_fk
        FROM information_schema.columns c
        WHERE c.table_schema = current_schema() AND c.table_name = ANY(${tables})
        ORDER BY c.table_name, c.ordinal_position`,
      this.prisma.$queryRaw<Array<{ typname: string; enumlabel: string }>>`
        SELECT t.typname, e.enumlabel FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = current_schema()
        ORDER BY t.typname, e.enumsortorder`,
      this.prisma.division.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { name: true } }),
    ]);
    const enumValues = new Map<string, string[]>();
    for (const e of enums) enumValues.set(e.typname, [...(enumValues.get(e.typname) ?? []), e.enumlabel]);
    const accountColumns = new Set(columns.filter((c) => c.table_name === 'User').map((c) => c.column_name));

    const fields: Field[] = [];
    for (const src of Object.values(SOURCES)) {
      const known = prismaScalars(src.model);
      for (const c of columns.filter((x) => x.table_name === src.model)) {
        if (!known.has(c.column_name)) continue;
        const el = eligibility({ source: src.key, column: c.column_name, isForeignKey: !!c.is_fk, accountColumns });
        if (el.hidden) continue;
        const t = typeOf(c, enumValues);
        if (!t) continue;   // JSON, binary …: not plain data
        let { type, values, enumType } = t;
        let reference: Field['reference'] = null;
        if (el.reference) {
          reference = el.reference.source === 'school' ? 'school' : 'division';
          type = reference === 'division' ? 'enum' : 'text';
          values = reference === 'division' ? divisions.map((d) => d.name) : null;
          enumType = 'Division';
        }
        const isList = type === 'enumList' || type === 'textList';
        fields.push({
          key: `${src.key}.${c.column_name}`, source: src.key, column: c.column_name, label: el.label, group: src.group,
          type, values, valueLabels: values && enumType !== 'Division' ? Object.fromEntries(values.map((v) => [v, enumLabel(enumType, v)])) : values ? Object.fromEntries(values.map((v) => [v, v])) : null,
          // A list is never NULL to the application (Prisma keeps [] for "none"), whatever the column allows.
          nullable: c.is_nullable === 'YES' && !isList, integer: /int/.test(c.data_type), maxLength: c.max_length ?? null,
          editVia: el.editVia, personal: el.personal,
          filterable: true,
          // Lists and the current school claim (one of many rows) cannot order the table.
          sortable: !isList && src.relation !== 'schoolAffiliations',
          reference,
        });
      }
    }
    this.cache = { at: Date.now(), fields };
    return fields;
  }

  /** The fields a category offers: its sources; student-only account columns only for students and "All users". */
  async forCategory(category: CategoryKey): Promise<Field[]> {
    const cat = CATEGORIES[category];
    return (await this.all()).filter((f) => cat.sources.includes(f.source)
      && !(f.source === 'user' && STUDENT_ONLY.has(f.column) && category !== 'STUDENTS' && category !== 'ALL'));
  }
}

function typeOf(c: ColumnRow, enumValues: Map<string, string[]>): { type: FieldType; values: string[] | null; enumType: string } | null {
  const dt = c.data_type;
  if (dt === 'text' || dt === 'character varying' || dt === 'character' || dt === 'uuid') return { type: 'text', values: null, enumType: '' };
  if (['integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision'].includes(dt)) return { type: 'number', values: null, enumType: '' };
  if (dt === 'boolean') return { type: 'boolean', values: null, enumType: '' };
  if (dt === 'date') return { type: 'date', values: null, enumType: '' };
  if (dt.startsWith('timestamp')) return { type: 'datetime', values: null, enumType: '' };
  if (dt === 'USER-DEFINED' && enumValues.has(c.udt_name)) return { type: 'enum', values: enumValues.get(c.udt_name)!, enumType: c.udt_name };
  if (dt === 'ARRAY') {
    const inner = c.udt_name.replace(/^_/, '');
    if (enumValues.has(inner)) return { type: 'enumList', values: enumValues.get(inner)!, enumType: inner };
    if (['text', 'varchar'].includes(inner)) return { type: 'textList', values: null, enumType: '' };
  }
  return null;
}
