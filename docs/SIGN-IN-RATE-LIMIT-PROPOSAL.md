# Sign-in rate limiting (2026-11-18): APPROVED by the owner and IMPLEMENTED in #62

Written for: the owner and the reviewing maintainer.

Implementation: `src/auth/login-limiter.ts`, `src/auth/auth.service.ts` (`login`), `src/auth/auth.controller.ts`
(the login route's throttle) on `feat/applications-complete` (#62), merged into #63.

## Problem (before)

`POST /auth/login` allowed 10 attempts per minute **per address**, plus a 5-wrong-password lock of 15 minutes for the
**whole account**. A class signing in together on one school connection shared those 10. Anyone who knew a student's
username could keep that student locked out from every address.

## Approved design (owner, 2026-11-18)

| Limit | Key | Value | Over the limit |
|---|---|---|---|
| Per username | normalised username or e-mail (trimmed, lower-case), HMAC-hashed with the server secret | 5 attempts a minute, 20 an hour, from any address | 429 `TOO_MANY_REQUESTS` with `retryAfter` |
| Per address | `req.ip` (from `TRUST_PROXY`, keep `1`) | 60 attempts a minute | 429 (throttler) |
| Lock | username + address | 5 wrong passwords in a row, 15 minutes | that address gets the wrong-password answer (the right password included); every other address can still sign in |

- **Every attempt counts towards the username windows, including successful ones.**
- **Unknown usernames** are counted, limited and locked exactly as real ones are. The answers are identical: the same
  401 "Invalid username or password.", the same 429, at the same points. The e2e test compares an unknown username with
  a real one, response by response.
- **The lock is scoped** to the address that made the failures. It is audited as `LOCK_ACCOUNT` with metadata
  `{ attempts: 5, scope: 'ADDRESS', ip, minutes: 15 }`. `User.lockedUntil` is no longer set.
- **A correct password** clears that address's failures. **A password reset** clears every lock of the account.
- **Concurrency:** each attempt is decided and recorded synchronously, with no await between the check and the
  record. Twenty simultaneous wrong guesses from one address produce exactly one lock (e2e).

## Two refinements made during implementation (please confirm)

1. **Known-address exemption.** As approved, the per-username windows count attempts from every address. An attacker
   could therefore use up a student's 5-a-minute and 20-an-hour allowance, and the student would get 429 everywhere for
   up to an hour. That contradicts the approved goal that an attacker cannot lock a student's account for everyone. So
   an address from which the account has **signed in successfully in the last 30 days** (taken from the `LOGIN` audit
   rows) is not held by the username windows. The lock for that username and address still applies. Attackers do not
   sign in from the student's own addresses, so their answers stay identical for real and unknown usernames. A student
   on a new address waits for the window to pass (at most an hour) or resets their password.
2. **Locks from the earlier release are honoured.** An unexpired `User.lockedUntil` written before this release is
   still respected until it expires, at most 15 minutes after deployment. It is answered like a wrong password. The
   `account-states` e2e test found that it would otherwise be dropped silently.

## Limits and notes

- The counters are held **in memory**. That is correct for one backend instance, which is today's deployment. A restart
  clears them, and several instances would need a shared store such as the database or Redis.
- The client address must be correct, so keep `TRUST_PROXY=1`. Behind Netlify, if every request arrives from the same
  proxy address, the 60-a-minute per-address limit applies to all users together, and the address locks apply to
  everyone behind that proxy address. The known-address exemption would then cover attackers too. Their guessing would
  still be capped by the lock for that username and address: 5 wrong passwords per 15 minutes, about 20 an hour. Staging
  must confirm the real client address (`operations/CLIENT-IP-VERIFICATION.md`) before release.
- **Correction to the proposal:** there is no Administrator "clear lock" control. With address-scoped locks the student
  can still sign in from other addresses, and a password reset clears every lock. A Super Admin break-glass credential
  reset sets a new password but does not clear an address lock that is still running (at most 15 minutes).
- The account-status `LOCKED` sign-in block now reflects only the legacy `lockedUntil`.
- Activation, password reset and resend stay at 10 a minute per address. The per-user budget of 120 a minute and the
  per-address ceiling are unchanged.

## Tests

- **Unit tests (`src/auth/auth.service.spec.ts`):**
  - A lock applies to one address only; another address can still sign in.
  - Unknown usernames get the same answers, and no `auditLog` lookup is made for them.
  - Per username, 5 attempts a minute and 20 an hour, with case and spaces normalised.
  - The known-address exemption.
  - A correct password clears the failures.
- **End-to-end tests, address-scoped lock (`test/security.e2e-spec.ts`):**
  - The lock and its audit metadata.
  - Another address can still sign in.
  - `lockedUntil` stays null.
  - An unknown username is locked identically.
  - Twenty parallel guesses produce exactly one lock.
- **End-to-end tests with throttling on (`test/rate-limit.e2e-spec.ts`):**
  - A class of 40 signs in from one address with no refusals.
  - Guesses from several addresses: the 6th attempt in a minute is refused, and the right password from an address the
    student never used is refused too. The school address the student used before is not held.
  - Unknown and real usernames get identical responses.
  - One address trying 61 accounts is refused at the 61st, and another address is unaffected.
