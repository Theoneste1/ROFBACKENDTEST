# Client addresses behind Netlify and Render: evidence and procedure (2026-11-18)

Written for: the owner and whoever configures Render, before go-live.

**Decision: leave `TRUST_PROXY` as it is (1) until the staging test below has been run.** Do not set it to 2 on
assumption. The local reproduction shows that, depending on how the Netlify proxy forwards `X-Forwarded-For`, `2` is
either correct or lets any client choose its own address (and so bypass every per-address limit).

## 1. Why it matters

Browsers call the API through the Netlify site's `/api/*` rewrite (`next.config.ts`, `API_PROXY_TARGET`), so the chain
is: browser → Netlify → Render's load balancer → the backend. Express derives `req.ip` from `X-Forwarded-For`, trusting
`TRUST_PROXY` hops (`src/main.ts`). Per-address limits (sign-in 10/min, public routes, the per-address ceiling) use
`req.ip`. Signed-in requests and session refreshes no longer depend on it (they count per user / per refresh token
since the final review), which limits the impact either way.

## 2. Local reproduction (no production, no real Netlify or Render)

Tool: `scripts/ops/client-ip-probe.mjs` (backend repository) answers with the TCP peer, the forwarding headers and
`req.ip` under `TRUST_PROXY` = false / 1 / 2 / 3 / true, computed with `proxy-addr` exactly as Express does.

Chain: a client bound to a known loopback address (127.0.0.5 or 127.0.0.6, `curl --interface`) → the real Next.js
server of the release candidate (`next start`, the same `/api/:path*` rewrite) → a load-balancer stand-in that appends
the peer address to `X-Forwarded-For` (an ASSUMPTION about Render) → the probe.

| # | Path | `X-Forwarded-For` at the app | req.ip, TRUST_PROXY=1 | =2 |
|---|---|---|---|---|
| A | 127.0.0.5 → Next → LB → app | `127.0.0.1` | 127.0.0.1 (the proxy) | 127.0.0.1 |
| B | 127.0.0.6 → Next → LB → app | `127.0.0.1` | 127.0.0.1 — same as A | 127.0.0.1 |
| C | 127.0.0.5 sending `X-Forwarded-For: 6.6.6.6` → Next → LB → app | `6.6.6.6, 127.0.0.1` | 127.0.0.1 | **6.6.6.6 (forged)** |
| D | 127.0.0.5 → LB → app (no Netlify) | `127.0.0.5` | **127.0.0.5 (correct)** | 127.0.0.5 |
| E | 127.0.0.5 sending `X-Forwarded-For: 6.6.6.6` → LB → app | `6.6.6.6, 127.0.0.5` | 127.0.0.5 (correct) | **6.6.6.6 (forged)** |

Findings:
1. The self-hosted Next.js rewrite does **not** add the client's address and passes a client-supplied
   `X-Forwarded-For` through unchanged (A, B, C). If Netlify's proxy behaved the same, no `TRUST_PROXY` value could
   recover the real client, and `2` would make the address forgeable.
2. With one proxy in front of the app (D, E), `1` is correct and not forgeable; `2` is forgeable.
3. Therefore `2` is safe **only if** Netlify's proxy appends the real client address as the entry just before
   Render's. That is Netlify's behaviour to confirm, not to assume.

## 3. Staging test (owner actions marked 🔑; never production credentials)

1. 🔑 Render: create a separate web service `rof-client-ip-probe` from the backend repository, start command
   `node scripts/ops/client-ip-probe.mjs`, no environment variables, no database.
2. 🔑 Netlify: in the staging site (§ STAGING-AND-RESTORE.md), set `API_PROXY_TARGET` to the probe's URL and deploy.
3. From two different networks (e.g. office Wi-Fi and a phone hotspot), open `https://<staging-site>/api/v1/probe`, and
   once with a forged header: `curl -H "X-Forwarded-For: 6.6.6.6" https://<staging-site>/api/v1/probe`. Note each
   network's public address (any "what is my IP" page).
4. Read `reqIp`:
   - **`TRUST_PROXY=2` shows each network's real address in both calls, and never 6.6.6.6** → set `TRUST_PROXY=2`
     (🔑 Render setting, separately approved).
   - `TRUST_PROXY=2` shows 6.6.6.6 for the forged call → keep `1`; Netlify does not append. Choose one of: (a) browsers
     call the API host directly (CORS; no Netlify hop; `1` is then correct — scenario D); (b) trust Netlify's own client
     header only from Netlify (needs a shared secret header added by Netlify and checked by the backend — a small
     change to approve).
   - Every call shows a Netlify address → as above.
5. Delete the probe service.

## 3a. Staging evidence so far (2026-11-18)

Direct to the staging backend on Render with `TRUST_PROXY=1`, one client making sequential requests was never held by
the per-address limits: 70 sign-ins without a 429, where the fixed limit is 60 and the same build locally refuses the
61st. So on Render `req.ip` is **not** the visitor's address; it varies between requests, which suggests proxy
addresses. **This affects production as it is configured today.**

- Per-address limits are weaker than designed.
- The sign-in lock scoped to an address is scoped to a proxy address. An attacker's 5 wrong passwords could lock the
  student out for anyone who passes through the same proxy address.

The probe (§3) must establish which header carries the real address, and whether a visitor can forge it, before the
sign-in release. Keep `TRUST_PROXY=1` until then; no other value has been shown to be safe.

## 4. Until then

`TRUST_PROXY=1` (unchanged) is the safe value: it cannot be forged. At worst, unauthenticated traffic shares the
Netlify proxy's addresses, so per-address limits are coarser — signed-in traffic is per user and unaffected.
