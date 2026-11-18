# Sign-in rate limiting: proposed design (2026-11-18) — NOT IMPLEMENTED, awaiting owner approval

Written for: the owner, to approve or change before any implementation.

## Problem

Today `POST /auth/login` allows 10 attempts per minute **per address** (plus a 5-wrong-password lock of 15 minutes per
account). A class signing in together on one school connection shares those 10, so most students wait a minute or more.
Behind the Netlify proxy the address may even be shared by everyone (CLIENT-IP-VERIFICATION.md).

## Proposed design: two independent limits, both must pass

| Limit | Key | Initial value | Protects against |
|---|---|---|---|
| Per account | normalised username (trimmed, lower-case; an e-mail address is normalised the same way) | 5 attempts per minute, 20 per hour | guessing one account's password from many addresses |
| Per address | `req.ip` | 60 attempts per minute | one address trying many accounts (credential stuffing) |

- **Normalisation:** the key is computed before the account is looked up, so unknown usernames are limited exactly like
  real ones (no account-existence oracle). Keys are hashed (HMAC with a server secret) before they reach the throttle
  store, so the store never holds usernames.
- **Distributed brute force (many addresses, one account):** the per-account limit caps it regardless of addresses;
  the existing lock after 5 wrong passwords stays.
- **Account-lockout denial of service:** an attacker who knows a student's username could keep that account locked.
  Mitigations, all within this design:
  1. the lock is **per account + address**: wrong passwords from address X lock that account only for address X
     (and for unknown addresses after a higher threshold, e.g. 20 wrong passwords per hour across all addresses);
  2. a successful sign-in from an address where the account was not failing is never blocked by another address's
     failures;
  3. an Administrator can clear a lock (existing account page);
  4. every lock and clear is audited (existing `LOCK_ACCOUNT` audit), and repeated locks raise an Administrator
     notice.
- **Responses** stay identical for wrong username / wrong password / limited (no oracle); 429 carries `retryAfter`.
- **Storage:** the in-process throttle store works for one backend instance (today); with several instances it must
  move to a shared store (e.g. the database or Redis) — noted for scaling, not needed now.

## What is unchanged

Activation, password reset and resend limits stay per address; the 120/min per-user budget and the per-address ceiling
from the final review stay.

## Tests to write once approved

A class of 40 students signing in from one address (all succeed); 6 wrong passwords for one account from 6 addresses
(the 6th refused); one address trying 61 accounts (the 61st refused); an attacker's wrong passwords do not stop the
real student signing in from another address; unknown and known usernames limited identically; audit rows.

**Decision needed:** approve, or change the values (5/min + 20/h per account, 60/min per address, per-address lock).
