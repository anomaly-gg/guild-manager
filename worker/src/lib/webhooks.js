// A team's Discord channels per alert kind. Each team_settings column holds up to
// PLANS.<plan>.webhooks channels as JSON [{ u: url, n: webhook name }]; a column saved before
// channels became lists holds one bare URL, read as a one-channel list.
// Messages we keep editing (boss alerts, the daily schedule post) are stored per channel as JSON
// { <webhook id>: <message id> }; a bare id saved before that belongs to the first channel.

import { isValidDiscordWebhook } from './discord.js';

export const KINDS = { url: 'webhook_url', boss: 'webhook_boss', events: 'webhook_events', schedule: 'webhook_schedule' };
export const PREMIUM_ONLY = ['boss', 'events'];   // their own channels; Free sends them to the main webhook

export const hookId = (url) => /\/webhooks\/(\d+)\//.exec(url)?.[1] || '';

// -> [{ u, n }], valid Discord webhooks only
export function parseHooks(value) {
  if (!value) return [];
  let list = [{ u: String(value).trim(), n: null }];
  if (String(value).trim().startsWith('[')) { try { list = JSON.parse(value); } catch { list = []; } }
  return (Array.isArray(list) ? list : []).filter(h => h && typeof h.u === 'string' && isValidDiscordWebhook(h.u));
}
export const hookUrls = (value) => parseHooks(value).map(h => h.u);
export const storeHooks = (list) => list.length ? JSON.stringify(list.map(h => ({ u: h.u, n: h.n || null }))) : null;

// For Settings: never the URL (the token in it lets anyone post), only the id and name.
export const publicHooks = (value) => parseHooks(value).map(h => ({ id: hookId(h.u), name: h.n || null }));

// Boss and event alerts go to their own channels when set, otherwise to the main webhook's.
export function alertHooks(settings, kind) {
  const own = hookUrls(settings?.[KINDS[kind]]);
  return own.length ? own : hookUrls(settings?.webhook_url);
}

// -> { hookId: msgId }
export function parseMsgs(value, hooks) {
  if (!value) return {};
  if (String(value).startsWith('{')) {
    try { const m = JSON.parse(value); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; } catch { return {}; }
  }
  const first = hooks[0] && hookId(hooks[0]);
  return first ? { [first]: value } : {};
}
export const storeMsgs = (map) => Object.keys(map).length ? JSON.stringify(map) : null;

// After a channel list change: keep only the entries of channels still in `after`.
export function keepMsgs(value, before, after) {
  const ids = new Set(after.map(hookId));
  return storeMsgs(Object.fromEntries(Object.entries(parseMsgs(value, before)).filter(([id]) => ids.has(id))));
}
