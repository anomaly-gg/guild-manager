// Discord webhook validation, embed sender, and post/edit of webhook messages we keep updating
// (daily schedule post, boss alerts). Every call is counted: the cron shares the free plan's
// 50 subrequests per run between Discord and phone pushes (cron/scheduled.js).

export function isValidDiscordWebhook(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== 'discord.com' && parsed.hostname !== 'discordapp.com') return false;
    // Validate full webhook path format: /api/webhooks/{id}/{token}
    if (!/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(parsed.pathname)) return false;
    return true;
  } catch { return false; }
}

let calls = 0;
export const discordCalls = { reset() { calls = 0; }, get count() { return calls; } };

// DISCORD_API (local harness only) swaps the host for the mock Discord.
const hostFor = (env, hook) => env?.DISCORD_API ? hook.replace(/^https:\/\/(discord|discordapp)\.com\/api/, env.DISCORD_API) : hook;

// One embed to one webhook URL or a list of them (every channel of an alert), in parallel.
export async function sendDiscord(env, hooks, title, description, color) {
  const body = JSON.stringify({
    embeds: [{ title: String(title).slice(0, 256), description: String(description).slice(0, 2048), color, footer: { text: 'Guild Manager' }, timestamp: new Date().toISOString() }],
  });
  await Promise.all([].concat(hooks || []).filter(isValidDiscordWebhook).map(async (hook) => {
    calls++;
    try {
      await fetch(hostFor(env, hook), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    } catch (e) { /* ignore */ }
  }));
}

// -> { ok, id?, status }
export async function webhookCall(env, hook, method, msgId, body) {
  const base = hostFor(env, hook);
  const url = msgId ? `${base}/messages/${msgId}` : `${base}?wait=true`;
  calls++;
  try {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { console.error('discord webhook', method, r.status, (await r.text().catch(() => '')).slice(0, 200)); return { ok: false, status: r.status }; }
    const d = method === 'POST' ? await r.json().catch(() => ({})) : {};
    return { ok: true, id: d.id, status: r.status };
  } catch (e) {
    console.error('discord webhook failed:', e);
    return { ok: false, status: 0 };
  }
}

// Does this webhook exist? -> { ok: true, name } | { ok: false, status } (status 0 = Discord unreachable)
export async function webhookInfo(env, hook) {
  calls++;
  try {
    const r = await fetch(hostFor(env, hook));
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json().catch(() => ({}));
    return { ok: true, name: typeof d.name === 'string' ? d.name.slice(0, 80) : null };
  } catch { return { ok: false, status: 0 }; }
}
