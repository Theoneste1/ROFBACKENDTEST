import { renderEmail, type EmailBrand } from './templates.js';

const brand: EmailBrand = {
  organization: 'Rwanda Olympiad Foundation',
  contactEmail: 'info@rwandaolympiadfoundation.org',
  appUrl:       'https://learn.rwandaolympiadfoundation.org',
};

describe('renderEmail', () => {
  const mail = renderEmail({
    firstName: 'Jeanne',
    heading:   'Reset your password',
    body:      'First paragraph.\n\nSecond paragraph.',
    action:    { label: 'Reset my password', url: 'https://learn.rwandaolympiadfoundation.org/reset-password?token=abc' },
    note:      'Valid for 30 minutes.',
  }, brand);

  it('renders a plain-text version with greeting, link, note and footer', () => {
    expect(mail.text).toBe([
      'Hello Jeanne,', '', 'First paragraph.\n\nSecond paragraph.', '',
      'Reset my password: https://learn.rwandaolympiadfoundation.org/reset-password?token=abc', '',
      'Valid for 30 minutes.', '', '—', 'Rwanda Olympiad Foundation', 'Questions? info@rwandaolympiadfoundation.org',
    ].join('\n'));
  });

  it('renders branded HTML with a button, fallback link, logo and contact', () => {
    expect(mail.html).toContain('<h1');
    expect(mail.html).toContain('Reset your password');
    expect(mail.html).toContain('Hello Jeanne,');
    expect(mail.html.match(/href="https:\/\/learn\.rwandaolympiadfoundation\.org\/reset-password\?token=abc"/g)).toHaveLength(2);
    expect(mail.html).toContain('>Reset my password</a>');
    expect(mail.html).toContain('src="https://learn.rwandaolympiadfoundation.org/logo.png"');
    expect(mail.html).toContain('mailto:info@rwandaolympiadfoundation.org');
    expect(mail.html).toContain('<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1F2937;');
  });

  it('escapes user-provided text in the HTML', () => {
    const html = renderEmail({ firstName: '<b>Eve</b>', body: 'a <script>alert(1)</script> & "q"' }, brand).html;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Eve</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;');
  });

  it('drops non-http(s) action links from the HTML', () => {
    const html = renderEmail({ body: 'x', action: { label: 'Click', url: 'javascript:alert(1)' } }, brand).html;
    expect(html).not.toContain('javascript:');
  });

  it('omits the logo for a non-public (http/localhost) APP_URL and greets without a name', () => {
    const local = renderEmail({ body: 'x' }, { ...brand, appUrl: 'http://localhost:3001' });
    expect(local.html).not.toContain('<img');
    expect(local.html).toContain('Hello,');
    expect(local.text.startsWith('Hello,\n')).toBe(true);
  });
});

describe('renderEmail greeting', () => {
  it('a whole greeting line replaces "Hello …," (decision notifications: "Dear …,"), escaped in the HTML', () => {
    const mail = renderEmail({ greeting: 'Dear Aline <b>,', firstName: 'Ignored', body: 'Body.' }, brand);
    expect(mail.text.split(/\r?\n/)[0]).toBe('Dear Aline <b>,');
    expect(mail.text).not.toContain('Hello');
    expect(mail.html).toContain('Dear Aline &lt;b&gt;,');
    expect(mail.html).not.toContain('Hello');
  });
});

describe('e-mail look and links (owner 2026-11-22)', () => {
  it('uses only the website blue #00428C (no other blue) for the header, headings, button and links', () => {
    const { html } = renderEmail({ heading: 'Welcome', body: 'x', action: { label: 'Log in', url: 'https://lms.rwandaolympiadfoundation.org/login' } }, brand);
    expect(html).not.toMatch(/#001E4E|#2B2BB2/i);
    const blues = [...new Set(html.match(/#00[0-9A-F]{4}\b/gi)?.map((c) => c.toUpperCase()))];
    expect(blues).toEqual(['#00428C']);
  });

  it('never shows the Netlify hosting address: links, logo and footer use the official address', async () => {
    const { emailSiteUrl, OFFICIAL_SITE_URL } = await import('./email-brand.js');
    expect(emailSiteUrl('https://roflms.netlify.app')).toBe(OFFICIAL_SITE_URL);
    expect(emailSiteUrl('https://ROFLMS.netlify.app/')).toBe(OFFICIAL_SITE_URL);
    expect(emailSiteUrl('https://lms.rwandaolympiadfoundation.org')).toBe('https://lms.rwandaolympiadfoundation.org');
    expect(emailSiteUrl('https://rof-staging.netlify.app')).toBe('https://rof-staging.netlify.app');   // staging keeps its own site
    expect(emailSiteUrl('http://localhost:3001')).toBe('http://localhost:3001');
    expect(emailSiteUrl('')).toBeNull();
    const { html, text } = renderEmail(
      { body: 'x', action: { label: 'Log in', url: `${emailSiteUrl('https://roflms.netlify.app')}/login` } },
      { ...brand, appUrl: emailSiteUrl('https://roflms.netlify.app') },
    );
    expect(html + text).not.toContain('netlify');
    expect(html).toContain('https://lms.rwandaolympiadfoundation.org/login');
    expect(html).toContain('https://lms.rwandaolympiadfoundation.org/logo.png');
  });
});
