/**
 * The datasets the directory sync accepts (school directory S2; owner-approved 2026-11-11).
 *
 * Trusted server-side configuration: an upload names a dataset by its key, which must be one of
 * these; the dataset key, data source, sheet, headers and normaliser version stored on a run
 * always come from here — never from a workbook value, file name or sheet title. Adding a source
 * (another export, another country) is a reviewed change to this file.
 */

/** The 18 columns of NESA's accredited-schools export, exactly as published. */
export const NESA_COLUMNS = [
  'No.', 'Province', 'District', 'Sector', 'Cell', 'Village', 'School Code', 'School Name',
  'Accommodation', 'School Status', 'Email', 'Phone', 'Pre-Primary', 'Primary', 'O-Level', 'A-Level',
  'Combinations/Trades/Other Programmes', 'All Education Levels (as listed by NESA)',
] as const;
export type NesaColumn = (typeof NESA_COLUMNS)[number];

export interface SyncDataset {
  key: string;
  /** SchoolDataSource.key */
  dataSourceKey: string;
  name: string;
  /** The data sheet of an .xlsx export (a .csv holds only the data). */
  sheet: string;
  /** The source's own totals, when the workbook has them. */
  summarySheet: string | null;
  columns: readonly string[];
  normaliserVersion: string;
}

export const SYNC_DATASETS: Readonly<Record<string, SyncDataset>> = {
  'NESA:ACCREDITED_SCHOOLS': {
    key: 'NESA:ACCREDITED_SCHOOLS',
    dataSourceKey: 'NESA',
    name: 'NESA accredited schools',
    sheet: 'All Schools',
    summarySheet: 'Summary',
    columns: NESA_COLUMNS,
    normaliserVersion: 'nesa-v1',
  },
};

export const SYNC_DATASET_KEYS = Object.keys(SYNC_DATASETS);

/** The configured dataset, or undefined for an unknown key. */
export function syncDataset(key: string | undefined): SyncDataset | undefined {
  return key !== undefined && Object.prototype.hasOwnProperty.call(SYNC_DATASETS, key) ? SYNC_DATASETS[key] : undefined;
}

/** Sync file limits (larger than the general import's: a whole directory export). */
export const SYNC_MAX_BYTES = 10 * 1024 * 1024;
export const SYNC_MAX_ROWS = 10_000;
export const SYNC_ZIP_MAX_UNCOMPRESSED = 120 * 1024 * 1024;
export const SYNC_ZIP_MAX_ENTRIES = 200;
/** A dry run can be reviewed (and, in S2b, applied) for 24 hours. */
export const SYNC_RUN_TTL_MS = 24 * 60 * 60 * 1000;
/** Staged raw data is purged 7 days after a run ended (expired, superseded or applied). */
export const SYNC_STAGING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
