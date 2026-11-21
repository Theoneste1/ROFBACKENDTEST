#!/usr/bin/env node
/**
 * Client-address probe (operations tool; never part of the application). It answers every request with what the
 * backend would see: the TCP peer address, the forwarding headers, and the address Express (`req.ip`, via proxy-addr —
 * the same library the backend uses) would derive under each candidate TRUST_PROXY value.
 *
 * Use it to decide TRUST_PROXY with evidence (docs/operations/CLIENT-IP-VERIFICATION.md):
 *   - locally, behind the real Next.js rewrite and a stand-in load balancer;
 *   - in STAGING, deployed as a separate Render web service and reached through a Netlify staging site's /api proxy.
 * It logs nothing and stores nothing; do not deploy it next to production.
 *
 *   PORT=4400 node scripts/ops/client-ip-probe.mjs
 */
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const proxyaddr = require('proxy-addr');

const CANDIDATES = { false: () => false, 1: 1, 2: 2, 3: 3, true: () => true };
const HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'x-nf-client-connection-ip', 'true-client-ip', 'cf-connecting-ip', 'via',
  // Hop markers only (identify no one): Cloudflare's request id and Netlify's request id prove which proxies a call crossed.
  'cf-ray', 'x-nf-request-id'];

const server = http.createServer((req, res) => {
  const reqIp = {};
  for (const [name, trust] of Object.entries(CANDIDATES)) {
    // TRUST_PROXY numbers are hop counts, as Express interprets app.set('trust proxy', n).
    const fn = typeof trust === 'number' ? ((_a, i) => i < trust) : trust;
    reqIp[`TRUST_PROXY=${name}`] = proxyaddr(req, fn);
  }
  const headers = Object.fromEntries(HEADERS.filter((h) => req.headers[h] !== undefined).map((h) => [h, req.headers[h]]));
  const body = JSON.stringify({ path: req.url, socketAddress: req.socket.remoteAddress, headers, reqIp }, null, 2);
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
});
server.listen(Number(process.env.PORT ?? 4400), () => console.log(`client-ip probe on :${process.env.PORT ?? 4400}`));
