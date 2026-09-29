// Discord slash commands (public route, signed by Discord): /link, /unlink, /next, /killed, /assign,
// /here, /rollcall.
//
// A Discord server belongs to one team; a team may link any number of servers (discord_guilds). /next is open to anyone in the
// linked server (the discovery surface); /killed needs the Discord account to be a member of the
// team in Guild Manager; /link, /unlink and /assign need officer+. Discord expects an answer within 3 s and
// this worker's database is far from Discord's servers, so commands are acknowledged with a
// deferred response and finished in ctx.waitUntil (editOriginal). Autocomplete has no deferral,
// so it does one query and answers directly.

import { json } from '../lib/http.js';
import { verifyToken } from '../lib/auth.js';
import { killBoss } from '../lib/boss-kill.js';
import { attendanceSettings, dayIn, claimFlags, alreadyClaimed, createClaim, fetchImage, storeImage } from '../lib/attendance.js';
import {
  InteractionType, verifyDiscordRequest, pong, message, deferred, choices, editOriginal,
  optionValue, focusedOption, invoker, linkGuild, unlinkGuild, deleteOriginal, followUpEphemeral,
} from '../lib/discord-interactions.js';
import { queueReplyCleanup } from '../lib/discord-cleanup.js';
import { nextSpawnsText, fmtDuration, clockIn } from '../lib/schedule-format.js';
import { parseGroups, groupTag, parseLater, cleanLater, MAX_LATER } from '../lib/spawn-groups.js';
import { spawnsInWindow } from '../lib/spawn-projection.js';
import { refreshSchedulePost } from '../lib/schedule-post.js';
import { killAlert } from '../lib/boss-alerts.js';

const APP_URL = 'https://anomaly-gg.github.io/guild-manager/';

async function linkedTeam(env, guildId) {
  if (!guildId) return null;
  return env.DB.prepare('SELECT t.id, t.name, ts.timezone, ts.public_token, ts.spawn_groups FROM discord_guilds g JOIN teams t ON t.id = g.team_id LEFT JOIN team_settings ts ON ts.team_id = t.id WHERE g.guild_id = ?')
    .bind(guildId).first();
}
async function membership(env, teamId, discordUserId) {
  return env.DB.prepare('SELECT m.user_id, m.role FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND u.discord_id = ?')
    .bind(teamId, discordUserId).first();
}
// A command result: plain text = the public reply; fail(text) = only the invoker should see it.
const fail = (text) => ({ text, error: true });
const footer = (team) => `\n-# Team time (${team.timezone || 'Asia/Manila'}) · ${team.public_token ? `[Timer page](${APP_URL}timers.html?t=${team.public_token}) · ` : ''}[Guild Manager](${APP_URL})`;

// ---- commands (each returns the text to show)

async function cmdLink(env, interaction) {
  const code = String(optionValue(interaction, 'code') || '').trim();
  const who = invoker(interaction);
  if (!interaction.guild_id) return 'Run this inside the Discord server you want to link.';
  const team = await env.DB.prepare('SELECT id, name FROM teams WHERE invite_code = ?').bind(code).first();
  if (!team) return 'No team has that invite code. It is in the team bar in Guild Manager.';
  const m = await membership(env, team.id, who.id);
  if (!m) return `Your Discord account is not a member of **${team.name}** in Guild Manager. Sign in there with Discord first.`;
  if (m.role === 'member') return 'Only the leader or an officer can link a server.';
  await linkGuild(env, { guildId: interaction.guild_id, teamId: team.id, userId: m.user_id });
  return `Linked this server to **${team.name}**. Everyone here can use \`/next\`; team members can log kills with \`/killed\`.`;
}

async function cmdUnlink(env, interaction) {
  const team = await linkedTeam(env, interaction.guild_id);
  if (!team) return 'This server is not linked to a team.';
  const m = await membership(env, team.id, invoker(interaction).id);
  if (!m || m.role === 'member') return 'Only the leader or an officer can unlink.';
  await unlinkGuild(env, interaction.guild_id);
  return `Unlinked **${team.name}** from this server.`;
}

async function cmdNext(env, interaction) {
  const team = await linkedTeam(env, interaction.guild_id);
  if (!team) return fail('This server is not linked to a team yet. A leader or officer runs `/link <invite code>`.');
  const count = Math.max(1, Math.min(25, Number(optionValue(interaction, 'count')) || 10));
  const bosses = await env.DB.prepare('SELECT * FROM bosses WHERE team_id = ?').bind(team.id).all();
  return `**${team.name}** — next spawns\n${nextSpawnsText(bosses.results, team.timezone || 'Asia/Manila', Date.now(), count, parseGroups(team.spawn_groups))}${footer(team)}`;
}

async function cmdKilled(env, interaction, after) {
  const team = await linkedTeam(env, interaction.guild_id);
  if (!team) return fail('This server is not linked to a team yet. A leader or officer runs `/link <invite code>`.');
  const who = invoker(interaction);
  const m = await membership(env, team.id, who.id);
  if (!m) return fail(`Only members of **${team.name}** in Guild Manager can log kills. Join the team there with your Discord account.`);
  const minutesAgo = Math.max(0, Math.min(1440, Number(optionValue(interaction, 'minutes_ago')) || 0));
  const bosses = (await env.DB.prepare('SELECT * FROM bosses WHERE team_id = ?').bind(team.id).all()).results;
  const boss = pickBoss(bosses, optionValue(interaction, 'boss'));
  if (typeof boss === 'string') return fail(boss);
  const deathTime = Date.now() - minutesAgo * 60000;
  const { nextSpawn, day } = await killBoss(env, { teamId: team.id, boss, deathTime, userId: m.user_id, tz: team.timezone, groups: parseGroups(team.spawn_groups) });
  after(() => refreshSchedulePost(env, team.id, { touchedDay: day }));
  after(() => killAlert(env, { teamId: team.id, boss, by: who.name, at: deathTime, nextSpawn }));
  const when = minutesAgo ? ` (${minutesAgo} min ago)` : '';
  return `☠️ **${boss.name}** killed by ${who.name}${when}. Next spawn in ${fmtDuration(nextSpawn - Date.now())} (${clockIn(nextSpawn, team.timezone || 'Asia/Manila')}).${footer(team)}`;
}

// Find one boss from an option value (autocomplete gives the id; typed text gives a name) -> row | error string
function pickBoss(bosses, raw) {
  const wanted = String(raw || '').trim();
  const exact = bosses.find(b => b.id === wanted) || bosses.find(b => b.name.toLowerCase() === wanted.toLowerCase());
  if (exact) return exact;
  const hits = bosses.filter(b => b.name.toLowerCase().includes(wanted.toLowerCase()));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return `Which one? ${hits.slice(0, 8).map(b => `**${b.name}**`).join(', ')}`;
  return `No boss called "${wanted}" on this team.`;
}

// /assign boss group [spawn] — officer tags one of the boss's coming spawns (1 = next, 2, 3) with a
// spawn group, or clears it with "none".
async function cmdAssign(env, interaction, after) {
  const team = await linkedTeam(env, interaction.guild_id);
  if (!team) return fail('This server is not linked to a team yet.');
  const m = await membership(env, team.id, invoker(interaction).id);
  if (!m || m.role === 'member') return fail('Only the leader or an officer can assign spawns.');
  const groups = parseGroups(team.spawn_groups);
  if (!groups.length) return fail('This team has no spawn groups yet. Add them in Guild Manager → Settings → Daily schedule post.');
  const bosses = (await env.DB.prepare('SELECT * FROM bosses WHERE team_id = ?').bind(team.id).all()).results;
  const boss = pickBoss(bosses, optionValue(interaction, 'boss'));
  if (typeof boss === 'string') return fail(boss);
  const g = String(optionValue(interaction, 'group') || '').trim();
  const group = g.toLowerCase() === 'none' ? null : groups.find(x => x.id === g) || groups.find(x => x.name.toLowerCase() === g.replace(/^@/, '').toLowerCase());
  if (group === undefined) return fail(`No group called "${g}". Groups: ${groups.map(x => x.name).join(', ')}.`);
  const which = Math.max(1, Math.min(1 + MAX_LATER, Number(optionValue(interaction, 'spawn')) || 1));
  const tz = team.timezone || 'Asia/Manila';
  if (which === 1) {
    await env.DB.prepare('UPDATE bosses SET spawn_group = ? WHERE id = ?').bind(group?.id || null, boss.id).run();
  } else {
    const later = parseLater(boss.later_groups);
    while (later.length < which - 1) later.push(null);
    later[which - 2] = group?.id || null;
    await env.DB.prepare('UPDATE bosses SET later_groups = ? WHERE id = ?').bind(cleanLater(later, new Set(groups.map(g => g.id))), boss.id).run();
  }
  after(() => refreshSchedulePost(env, team.id));
  const spawn = spawnsInWindow(boss, 0, Infinity, tz, groups).find(s => s.index === which - 1);
  const at = spawn ? clockIn(spawn.at, tz) : '?';
  const label = which === 1 ? 'next spawn' : `${which === 2 ? '2nd' : '3rd'} spawn`;
  return `**${boss.name}** ${label} (~${at}) → ${group ? groupTag(groups, group.id) : 'no group'}`;
}

// Resolve boss option values (autocomplete gives ids; typed text gives names) -> [{ id, name }] | error string
function pickBosses(bosses, values) {
  const out = [];
  for (const raw of values) {
    const wanted = String(raw || '').trim(); if (!wanted) continue;
    let boss = bosses.find(b => b.id === wanted) || bosses.find(b => b.name.toLowerCase() === wanted.toLowerCase());
    if (!boss) { const hits = bosses.filter(b => b.name.toLowerCase().includes(wanted.toLowerCase())); if (hits.length === 1) boss = hits[0]; }
    if (!boss) return `No boss called "${wanted}" on this team.`;
    if (!out.some(b => b.id === boss.id)) out.push({ id: boss.id, name: boss.name });
  }
  return out.length ? out : 'Pick at least one boss.';
}

// /here boss [boss2] proof [note] — member self check-in with a screenshot
async function cmdHere(env, interaction) {
  const team = await linkedTeam(env, interaction.guild_id);
  if (!team) return fail('This server is not linked to a team yet.');
  const who = invoker(interaction);
  const m = await membership(env, team.id, who.id);
  if (!m) return `Only members of **${team.name}** in Guild Manager can check in. Join the team there with your Discord account.`;
  const cfg = await attendanceSettings(env, team.id);
  if (!cfg.selfCheckin) return 'This team logs attendance by officer roll call only. Ask an officer to run `/rollcall`.';
  const bosses = (await env.DB.prepare('SELECT id, name FROM bosses WHERE team_id = ?').bind(team.id).all()).results;
  const picked = pickBosses(bosses, [optionValue(interaction, 'boss'), optionValue(interaction, 'boss2')]);
  if (typeof picked === 'string') return fail(picked);
  const day = dayIn(cfg.tz);
  const dup = await alreadyClaimed(env, { teamId: team.id, userId: m.user_id, bosses: picked, day });
  if (dup.length) return `You already checked in for ${dup.join(', ')} today.`;
  const attId = optionValue(interaction, 'proof');
  const att = interaction.data?.resolved?.attachments?.[attId];
  if (!att) return 'Attach a screenshot as proof.';
  if (att.content_type && !att.content_type.startsWith('image/')) return 'The proof must be an image.';
  const img = await fetchImage(att.url, att.size);
  if (!img) return 'Could not read that screenshot (max 8 MB). Try again.';
  const note = String(optionValue(interaction, 'note') || '').trim().slice(0, 200) || null;
  const flags = await claimFlags(env, { teamId: team.id, userId: m.user_id, bosses: picked, day, tz: cfg.tz, imageHash: img.hash });
  const status = cfg.autoApprove && flags.length === 0 ? 'approved' : 'pending';
  const { id, points } = await createClaim(env, { teamId: team.id, userId: m.user_id, bosses: picked, day, source: 'screenshot', imageHash: img.hash, note, flags, status, pointsPerBoss: cfg.pointsPerBoss });
  await storeImage(env, { teamId: team.id, claimId: id, buf: img.buf, contentType: att.content_type });
  const names = picked.map(b => b.name).join(' + ');
  if (status === 'approved') return `✅ Checked in for **${names}** — approved, +${points} pt${points === 1 ? '' : 's'}.`;
  return `📸 Checked in for **${names}** — pending an officer's review${flags.length ? ` (flagged: ${flags.map(f => f.text).join('; ')})` : ''}.`;
}

// /rollcall boss members [boss2] [note] — officer logs who was in the rally; approved immediately
async function cmdRollcall(env, interaction) {
  const team = await linkedTeam(env, interaction.guild_id);
  if (!team) return fail('This server is not linked to a team yet.');
  const who = invoker(interaction);
  const m = await membership(env, team.id, who.id);
  if (!m || m.role === 'member') return fail('Only the leader or an officer can run a roll call.');
  const cfg = await attendanceSettings(env, team.id);
  const bosses = (await env.DB.prepare('SELECT id, name FROM bosses WHERE team_id = ?').bind(team.id).all()).results;
  const picked = pickBosses(bosses, [optionValue(interaction, 'boss'), optionValue(interaction, 'boss2')]);
  if (typeof picked === 'string') return fail(picked);
  const mentioned = [...String(optionValue(interaction, 'members') || '').matchAll(/<@!?(\d+)>/g)].map(x => x[1]);
  if (!mentioned.length) return fail('Mention the members who were there, e.g. `@Kaizuka @Ratan`.');
  const rows = (await env.DB.prepare(`SELECT m.user_id, u.username, u.discord_id FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND u.discord_id IN (${mentioned.map(() => '?').join(',')})`).bind(team.id, ...mentioned).all()).results;
  const day = dayIn(cfg.tz);
  const note = String(optionValue(interaction, 'note') || '').trim().slice(0, 200) || null;
  const logged = [], skipped = [];
  for (const r of rows) {
    const dup = await alreadyClaimed(env, { teamId: team.id, userId: r.user_id, bosses: picked, day });
    if (dup.length) { skipped.push(r.username); continue; }
    await createClaim(env, { teamId: team.id, userId: r.user_id, bosses: picked, day, source: 'rollcall', note, status: 'approved', pointsPerBoss: cfg.pointsPerBoss, reviewerId: m.user_id });
    logged.push(r.username);
  }
  const unknown = mentioned.length - rows.length;
  const names = picked.map(b => b.name).join(' + ');
  return `📋 Roll call for **${names}** by ${who.name}: ${logged.length ? logged.join(', ') : 'nobody new'} (+${cfg.pointsPerBoss * picked.length} pt${cfg.pointsPerBoss * picked.length === 1 ? '' : 's'} each)` +
    (skipped.length ? `\n-# already logged today: ${skipped.join(', ')}` : '') +
    (unknown ? `\n-# ${unknown} mentioned ${unknown === 1 ? 'person is' : 'people are'} not on the team in Guild Manager (Discord sign-in needed)` : '');
}

const COMMANDS = { link: cmdLink, unlink: cmdUnlink, next: cmdNext, killed: cmdKilled, assign: cmdAssign, here: cmdHere, rollcall: cmdRollcall };
const EPHEMERAL_COMMANDS = new Set(['link', 'unlink', 'here']);

export const routes = [
  // GET /discord/added?guild_id&state — Discord sends the leader here after "Add to Discord".
  // The state is our signed token naming the team and the user; guild_id is the server they picked.
  { method: 'GET', pattern: '/discord/added', handler: async ({ env, url }) => {
    const back = (q) => Response.redirect(`${APP_URL}?discord=${q}`, 302);
    const guildId = url.searchParams.get('guild_id');
    const state = await verifyToken(url.searchParams.get('state') || '', env.JWT_SECRET);
    if (url.searchParams.get('error')) return back('cancelled');
    if (!state || state.kind !== 'discord-link' || !guildId) return back('error');
    const m = await env.DB.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').bind(state.teamId, state.userId).first();
    if (!m || m.role === 'member') return back('error');
    await linkGuild(env, { guildId, teamId: state.teamId, userId: state.userId });
    return back('linked');
  } },

  { method: 'POST', pattern: '/discord/interactions', handler: async ({ request, env, ctx }) => {
    const raw = await request.text();
    if (!(await verifyDiscordRequest(request, raw, env.DISCORD_PUBLIC_KEY))) return json({ error: 'bad signature' }, 401);
    let interaction;
    try { interaction = JSON.parse(raw); } catch { return json({ error: 'bad body' }, 400); }

    if (interaction.type === InteractionType.PING) return pong();
    console.log('discord interaction', JSON.stringify({ type: interaction.type, command: interaction.data?.name, guild: interaction.guild_id, user: (interaction.member?.user || interaction.user || {}).id }));
    // `/rollcall` takes a while when many members are mentioned; still under the 15-minute follow-up window.

    if (interaction.type === InteractionType.AUTOCOMPLETE) {
      const team = await linkedTeam(env, interaction.guild_id);
      if (!team) return choices([]);
      const focused = focusedOption(interaction);
      const q = String(focused?.value || '').toLowerCase();
      if (focused?.name === 'group') {
        const groups = parseGroups(team.spawn_groups).filter(g => !q || g.name.toLowerCase().includes(q));
        return choices([...groups.map(g => ({ name: g.name.slice(0, 100), value: g.id })), { name: 'No group (clear)', value: 'none' }]);
      }
      const bosses = (await env.DB.prepare('SELECT id, name FROM bosses WHERE team_id = ? ORDER BY name').bind(team.id).all()).results;
      return choices(bosses.filter(b => !q || b.name.toLowerCase().includes(q)).map(b => ({ name: b.name.slice(0, 100), value: b.id })));
    }

    if (interaction.type === InteractionType.COMMAND) {
      const name = interaction.data?.name;
      const fn = COMMANDS[name];
      if (!fn) return message(`Unknown command /${name}`, true);
      const ephemeral = EPHEMERAL_COMMANDS.has(name);
      const later = [];   // follow-up work that should not hold up the reply (schedule post edits)
      const work = fn(env, interaction, (task) => later.push(task))
        .catch(e => { console.error(`discord /${name} failed:`, e); return fail('Something went wrong on our side. Try again in a minute.'); })
        .then(async (result) => {
          const text = typeof result === 'string' ? result : result.text;
          // An error in a public command: drop the public placeholder and tell only the invoker.
          if (result?.error && !ephemeral) {
            await deleteOriginal(env, interaction.token);
            return followUpEphemeral(env, interaction.token, text);
          }
          await editOriginal(env, interaction.token, text);
          if (!ephemeral) await queueReplyCleanup(env, { command: name, guildId: interaction.guild_id, token: interaction.token });
        })
        .then(() => Promise.allSettled(later.map(task => task())));
      if (ctx?.waitUntil) { ctx.waitUntil(work); return deferred(ephemeral); }
      await work; return deferred(ephemeral);   // local harness without ctx
    }

    return json({ error: 'unsupported interaction' }, 400);
  } },
];
