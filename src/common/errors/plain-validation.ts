/**
 * Validation messages in plain words (owner 2026-11-22: "always give an error message which is really understandable").
 *
 * The validation pipe produces messages such as "opensAt must be a valid ISO 8601 date string" or "property foo should
 * not exist". They stay unchanged in `details` (clients match them to their form fields by the leading property name);
 * the response's `message` is the first problem rewritten for a person: "Opens at must be a valid date and time."
 * Messages that are already written for people (custom DTO messages) are returned as they are.
 */

/** "opensAt" → "Opens at"; "questions.0.prompt" → "Question 1: prompt"; "schoolId" → "School". */
export function fieldLabel(path: string): string {
  const parts = path.split('.');
  const words: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (/^\d+$/.test(p)) continue;
    const next = parts[i + 1];
    let w = p
      .replace(/(Ids?|Code)$/, (m) => (m === 'Code' ? ' code' : ''))
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .trim();
    if (next !== undefined && /^\d+$/.test(next)) w = `${w.replace(/s$/, '')} ${Number(next) + 1}:`;
    words.push(w);
  }
  const text = words.join(' ').replace(/:\s*$/, '').trim() || 'This field';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const RULES: Array<[RegExp, (label: string, m: RegExpMatchArray) => string]> = [
  [/^property (\S+) should not exist$/, (_l, m) => `${fieldLabel(m[1])} isn't accepted here. Refresh the page and try again (the app may have been updated).`],
  [/^(\S+) should not be empty$/, (l) => `${l} is required.`],
  [/^(\S+) must be a string$/, (l) => `${l} must be text.`],
  [/^(\S+) must be longer than or equal to (\d+) characters?$/, (l, m) => `${l} must be at least ${m[2]} character${m[2] === '1' ? '' : 's'} long.`],
  [/^(\S+) must be shorter than or equal to (\d+) characters?$/, (l, m) => `${l} must be at most ${m[2]} characters long.`],
  [/^(\S+) must be a valid ISO 8601 date string$/, (l) => `${l} must be a valid date and time.`],
  [/^(\S+) must be a Date instance$/, (l) => `${l} must be a valid date.`],
  [/^(\S+) must be a UUID$/, (l) => `${l}: choose an item from the list (the reference sent isn't valid).`],
  [/^each value in (\S+) must be a UUID$/, (l) => `${l}: one of the chosen items isn't valid. Refresh the page and choose again.`],
  [/^(\S+) must be one of the following values: (.+)$/, (l) => `${l}: choose one of the options offered.`],
  [/^each value in (\S+) must be one of the following values: (.+)$/, (l) => `${l}: choose only from the options offered.`],
  [/^(\S+) must be an integer number$/, (l) => `${l} must be a whole number.`],
  [/^(\S+) must be a number conforming to the specified constraints$/, (l) => `${l} must be a number.`],
  [/^(\S+) must not be less than (-?[\d.]+)$/, (l, m) => `${l} must be ${m[2]} or more.`],
  [/^(\S+) must not be greater than (-?[\d.]+)$/, (l, m) => `${l} must be ${m[2]} or less.`],
  [/^(\S+) must be a positive number$/, (l) => `${l} must be more than 0.`],
  [/^(\S+) must be an email$/, (l) => `${l} must be a valid e-mail address (like name@example.com).`],
  [/^(\S+) must be a boolean value$/, (l) => `${l} must be yes or no.`],
  [/^(\S+) must be an array$/, (l) => `${l} must be a list.`],
  [/^(\S+) must contain at least (\d+) elements?$/, (l, m) => `${l}: choose at least ${m[2]}.`],
  [/^(\S+) must contain not more than (\d+) elements?$/, (l, m) => `${l}: choose at most ${m[2]}.`],
  [/^(\S+)'s elements must be unique$/, (l) => `${l}: each item may be chosen only once.`],
  [/^(\S+) must match .+ regular expression$/, (l) => `${l} isn't in the expected format.`],
  [/^(\S+) must be a URL address$/, (l) => `${l} must be a web address starting with https://.`],
  [/^(\S+) must be a valid phone number$/, (l) => `${l} must be a valid phone number.`],
  [/^(\S+) must be an object$/, (l) => `${l} isn't valid. Refresh the page and try again.`],
  [/^nested property (\S+) must be either object or array$/, (l) => `${l} isn't valid. Refresh the page and try again.`],
];

/** One validation message in plain words (unchanged when it is already written for people). */
export function plainValidationMessage(raw: string): string {
  const msg = raw.trim();
  for (const [re, write] of RULES) {
    const m = msg.match(re);
    if (m) return write(fieldLabel(m[1]), m);
  }
  // A custom message beginning with the property name ("closesAt must be after opensAt"): give the name a label.
  const lead = msg.match(/^([a-z]+[A-Z][A-Za-z]*(?:\.\d+\.[A-Za-z]+)*)\b(.*)$/);
  if (lead) return `${fieldLabel(lead[1])}${lead[2]}`;
  return msg.charAt(0).toUpperCase() + msg.slice(1);
}

/** The response's message for a refused form: the first problem, and how many more there are. */
export function validationSummary(messages: readonly string[]): string {
  if (messages.length === 0) return 'Some of the information is missing or not valid. Check the form and try again.';
  const first = plainValidationMessage(messages[0]);
  const more = messages.length - 1;
  return more > 0 ? `${first} (and ${more} more problem${more === 1 ? '' : 's'} — check the form)` : first;
}
