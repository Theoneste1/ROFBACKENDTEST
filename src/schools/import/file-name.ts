/**
 * An uploaded file's name is untrusted (PR D): only a cleaned version is ever stored (audit
 * metadata) or returned. The raw name is never logged or echoed; the file's SHA-256 is kept for
 * traceability instead.
 *
 *   - path components removed (anything up to the last "/" or "\")
 *   - control and invisible formatting characters removed (Unicode Cc and Cf — including
 *     direction overrides such as U+202E that can disguise an extension)
 *   - whitespace collapsed and trimmed; at most MAX_FILE_NAME characters; "upload" if empty
 */
export const MAX_FILE_NAME = 120;

export function sanitizeFileName(raw: string | null | undefined): string {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  const cut = [...clean].slice(0, MAX_FILE_NAME).join('').trim();   // by code point: never splits a surrogate pair
  return cut || 'upload';
}
