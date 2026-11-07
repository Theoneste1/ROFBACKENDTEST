/**
 * E-mail templates: every message is rendered twice, as plain text and as a
 * branded, responsive HTML page (table layout and inline styles, which is
 * what e-mail clients support).
 *
 * All values are escaped before they go into the HTML; links are only
 * allowed for http(s) URLs.
 */

export interface EmailAction {
  /** Button text, e.g. "Reset password". */
  label: string;
  /** Absolute http(s) URL. */
  url:   string;
}

export interface EmailContent {
  /** First name for "Hello Jeanne,"; omitted → "Hello,". */
  firstName?:  string | null;
  /** Large title at the top of the card; also used as the preview text. */
  heading?:    string;
  /** Main text. Blank lines separate paragraphs. */
  body:        string;
  /** Call-to-action button. */
  action?:     EmailAction;
  /** Small print under the button (link validity, "ignore if not you"). */
  note?:       string;
}

export interface EmailBrand {
  /** Organisation shown in the header and footer. */
  organization: string;
  /** Contact address in the footer. */
  contactEmail: string | null;
  /** Frontend URL (logo and footer link); only used when it is public https. */
  appUrl:       string | null;
}

export interface RenderedEmail {
  text: string;
  html: string;
}

export const ORGANIZATION = 'Rwanda Olympiad Foundation';

const NAVY   = '#001E4E';
const ACCENT = '#2B2BB2';
const MUTED  = '#5B6577';
const BG     = '#E6EBF2';

export function renderEmail(content: EmailContent, brand: EmailBrand): RenderedEmail {
  return { text: renderText(content, brand), html: renderHtml(content, brand) };
}

// ─── Plain text ──────────────────────────────────────────────────────────────

function renderText(c: EmailContent, b: EmailBrand): string {
  const lines = [c.firstName ? `Hello ${c.firstName},` : 'Hello,', '', c.body.trim()];
  if (c.action) lines.push('', `${c.action.label}: ${c.action.url}`);
  if (c.note) lines.push('', c.note);
  lines.push('', '—', b.organization);
  if (b.contactEmail) lines.push(`Questions? ${b.contactEmail}`);
  return lines.join('\n');
}

// ─── HTML ────────────────────────────────────────────────────────────────────

function renderHtml(c: EmailContent, b: EmailBrand): string {
  const font = "font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  const publicUrl = b.appUrl && /^https:\/\//i.test(b.appUrl) ? b.appUrl.replace(/\/$/, '') : null;
  const preview = c.heading ?? c.body.split('\n')[0];

  const header = publicUrl
    ? `<img src="${attr(`${publicUrl}/logo.png`)}" width="44" height="44" alt="" style="display:inline-block;vertical-align:middle;border:0;border-radius:8px;margin-right:12px">` +
      `<span style="vertical-align:middle;color:#ffffff;font-size:17px;font-weight:600;${font}">${esc(b.organization)}</span>`
    : `<span style="color:#ffffff;font-size:17px;font-weight:600;${font}">${esc(b.organization)}</span>`;

  const paragraphs = c.body.trim().split(/\n\s*\n/).map((p) =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1F2937;${font}">${esc(p).replace(/\n/g, '<br>')}</p>`,
  ).join('');

  const action = c.action && isHttpUrl(c.action.url)
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr>
         <td style="border-radius:8px;background:${ACCENT}">
           <a href="${attr(c.action.url)}" target="_blank" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;${font}">${esc(c.action.label)}</a>
         </td></tr></table>
       <p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:${MUTED};${font}">If the button does not work, copy this link into your browser:<br>
         <a href="${attr(c.action.url)}" target="_blank" style="color:${ACCENT};word-break:break-all">${esc(c.action.url)}</a></p>`
    : '';

  const note = c.note
    ? `<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:${MUTED};${font}">${esc(c.note)}</p>`
    : '';

  const footerLines = [
    `<strong style="color:${NAVY}">${esc(b.organization)}</strong>`,
    b.contactEmail ? `Questions? Write to <a href="mailto:${attr(b.contactEmail)}" style="color:${ACCENT}">${esc(b.contactEmail)}</a>` : '',
    publicUrl ? `<a href="${attr(publicUrl)}" style="color:${ACCENT}">${esc(publicUrl.replace(/^https:\/\//, ''))}</a>` : '',
  ].filter(Boolean).join('<br>');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(c.heading ?? b.organization)}</title>
</head>
<body style="margin:0;padding:0;background:${BG}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG}">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
      <tr><td style="background:${NAVY};padding:20px 28px;border-radius:12px 12px 0 0">${header}</td></tr>
      <tr><td style="background:#ffffff;padding:32px 28px 24px">
        ${c.heading ? `<h1 style="margin:0 0 20px;font-size:22px;line-height:1.3;color:${NAVY};${font}">${esc(c.heading)}</h1>` : ''}
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1F2937;${font}">${c.firstName ? `Hello ${esc(c.firstName)},` : 'Hello,'}</p>
        ${paragraphs}
        ${action}
        ${note}
      </td></tr>
      <tr><td style="background:#F8FAFC;padding:20px 28px;border-radius:0 0 12px 12px;border-top:1px solid #E2E8F0;font-size:13px;line-height:1.6;color:${MUTED};${font}">
        ${footerLines}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const attr = esc;

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
