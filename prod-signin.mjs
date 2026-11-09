#!/usr/bin/env node
// One-time production sign-in for one QuickBooks company file.
// Intuit won't accept a localhost redirect in production, so Intuit redirects to the
// GitHub Pages callback page, which hands the code to this script on 127.0.0.1:8000.
//
// Usage (on the Mac, in ~/mcp/quickbooks-online-mcp-server):
//   node prod-signin.mjs .env.she-2026
// The file must already contain the PRODUCTION QUICKBOOKS_CLIENT_ID and
// QUICKBOOKS_CLIENT_SECRET. This script adds the refresh token and company (realm) ID.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const REDIRECT = 'https://etan15.github.io/she-intuit-app/callback.html';
const SCOPE = 'com.intuit.quickbooks.accounting'; // Accounting only: no payments, payroll or profile
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Give the settings file to fill in, e.g.: node prod-signin.mjs .env.she-2026');
  process.exit(1);
}

const read = () => Object.fromEntries(
  fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));

const env = read();
const id = env.QUICKBOOKS_CLIENT_ID, secret = env.QUICKBOOKS_CLIENT_SECRET;
if (!id || !secret) { console.error(`${file} is missing the client ID or secret.`); process.exit(1); }

function save(values) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    text = new RegExp(`^${k}=.*$`, 'm').test(text)
      ? text.replace(new RegExp(`^${k}=.*$`, 'm'), line)
      : text.replace(/\n?$/, `\n${line}\n`);
  }
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const state = crypto.randomBytes(24).toString('hex');
let done = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8000');
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
  if (url.searchParams.get('state') !== state) {
    res.writeHead(400).end('State check failed. Run the sign-in again.');
    console.error('Rejected a callback with the wrong state.');
    return;
  }
  if (done) { res.writeHead(200).end('Already connected. You can close this tab.'); return; }
  done = true;

  const code = url.searchParams.get('code');
  const realm = url.searchParams.get('realmId');
  try {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }),
    });
    const tid = r.headers.get('intuit_tid');
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.refresh_token) {
      throw new Error(`Intuit said ${r.status} ${body.error || ''} ${body.error_description || ''} (intuit_tid ${tid})`);
    }
    save({
      QUICKBOOKS_REFRESH_TOKEN: body.refresh_token,
      QUICKBOOKS_REALM_ID: realm,
      QUICKBOOKS_ENVIRONMENT: 'production',
      QUICKBOOKS_REDIRECT_URI: REDIRECT,
    });
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Connected. You can close this tab.');
    console.log(`Connected company ${realm}. Saved to ${file}.`);
    server.close(() => process.exit(0));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Sign-in failed. Check the Terminal window.');
    console.error('Sign-in failed:', e.message);
    server.close(() => process.exit(1));
  }
});

server.listen(8000, '127.0.0.1', () => {
  const link = `${AUTH_URL}?` + new URLSearchParams({
    client_id: id, response_type: 'code', scope: SCOPE, redirect_uri: REDIRECT, state,
  });
  console.log('Opening your browser. Sign in, then pick the company to connect.');
  console.log('If the browser does not open, paste this link into it:\n' + link + '\n');
  execFile('open', [link], () => {});
});

setTimeout(() => { console.error('Timed out after 10 minutes. Run it again.'); process.exit(1); }, 600_000);
