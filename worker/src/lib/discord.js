// Discord webhook validation, embed sender, and post/edit of webhook messages we keep updating
// (daily schedule post, boss alerts).

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

export async function sendDiscord(webhookUrl, title, description, color) {
  if (!webhookUrl || !isValidDiscordWebhook(webhookUrl)) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{ title: String(title).slice(0, 256), description: String(description).slice(0, 2048), color, footer: { text: 'Guild Manager' }, timestamp: new Date().toISOString() }],
      }),
    });
  } catch (e) { /* ignore */ }
}

// -> { ok, id?, status }. DISCORD_API (local harness only) swaps the host for the mock Discord.
export async function webhookCall(env, hook, method, msgId, body) {
  const base = env.DISCORD_API ? hook.replace(/^https:\/\/(discord|discordapp)\.com\/api/, env.DISCORD_API) : hook;
  const url = msgId ? `${base}/messages/${msgId}` : `${base}?wait=true`;
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
