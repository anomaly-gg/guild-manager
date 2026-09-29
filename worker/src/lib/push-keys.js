// VAPID keys for phone alerts, made by the worker itself on first use and kept in app_state
// ('vapid_keys'), so there is no secret to set up (same idea as the slash-command auto-sync).
// The public half goes to browsers (GET /api/push/key); the private half never leaves the worker.
// Per-isolate caches: the keys, and one signed Authorization header per push-service origin.

import { generateVapidKeys, vapidAuth } from './webpush.js';

const KEY = 'vapid_keys';
// VAPID "sub": how a push service can reach whoever runs this sender. The site, not a person's email.
const SUBJECT = 'https://anomaly-gg.github.io/guild-manager/';

let keys = null;
const authCache = new Map();   // origin -> { header, expires }

export async function getVapidKeys(env) {
  if (keys) return keys;
  const row = await env.DB.prepare('SELECT value FROM app_state WHERE key = ?').bind(KEY).first();
  if (row?.value) return (keys = JSON.parse(row.value));
  const made = await generateVapidKeys();
  // Two isolates may race on the very first use: the first insert wins and both read that one back.
  await env.DB.prepare('INSERT OR IGNORE INTO app_state (key, value) VALUES (?, ?)').bind(KEY, JSON.stringify(made)).run();
  const kept = await env.DB.prepare('SELECT value FROM app_state WHERE key = ?').bind(KEY).first();
  return (keys = JSON.parse(kept.value));
}

// Authorization header for a subscription endpoint (signed once per origin per ~11 h).
export async function authFor(env, endpoint, now = Date.now()) {
  const origin = new URL(endpoint).origin;
  const hit = authCache.get(origin);
  if (hit && hit.expires > now) return hit.header;
  const a = await vapidAuth(endpoint, await getVapidKeys(env), SUBJECT, now);
  authCache.set(origin, a);
  return a.header;
}
