// M16 daily schedule post + spawn groups, against `wrangler dev --local --test-scheduled` (8788).
// argv[2] = test Ed25519 private key PEM, argv[3] = worker dir. Mock Discord on 8797 records
// interaction follow-ups and schedule webhook posts/edits.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import http from 'node:http';

const W = 'http://127.0.0.1:8788';
const WORKER_DIR = process.argv[3];
const priv = createPrivateKey(readFileSync(process.argv[2], 'utf8'));
const checks = [];
const check = (name, cond, info = '') => { checks.push(!!cond); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : `   <- ${typeof info === 'string' ? info : JSON.stringify(info).slice(0, 600)}`)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// workerd drops idle keep-alive sockets while the slow `d1 execute` calls run; retry once on a reset.
const fetch = async (url, opts) => { try { return await globalThis.fetch(url, opts); } catch (e) { if (e.cause?.code !== 'ECONNRESET') throw e; await sleep(100); return globalThis.fetch(url, opts); } };

// ---- mock Discord
const edits = new Map();            // interaction token -> content
const hooks = [];                   // { method, msg, body }
let msgN = 0, failPosts = false;
const cmdPuts = [];              // slash command registrations
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    let m = req.url.match(/^\/webhooks\/(\d+)\/([^/?]+)\/messages\/@original$/);
    if (req.method === 'PATCH' && m) { edits.set(m[2], JSON.parse(body).content); return send(200, {}); }
    m = req.url.match(/^\/webhooks\/(\d+)\/([^/?]+)$/);   // private follow-up to a command
    if (req.method === 'POST' && m) { edits.set(m[2], JSON.parse(body).content); return send(200, {}); }
    m = req.url.match(/^\/webhooks\/(\d+)\/([^/?]+)\?wait=true$/);
    if (req.method === 'POST' && m) {
      if (failPosts) return send(failPosts === 'perm' ? 400 : 500, { message: 'boom' });
      const id = 'm' + (++msgN); hooks.push({ method: 'POST', msg: id, hook: m[1], body: JSON.parse(body) }); return send(200, { id });
    }
    m = req.url.match(/^\/webhooks\/(\d+)\/([^/?]+)\/messages\/(\w+)$/);
    if (req.method === 'PATCH' && m) {
      if (m[3] === 'gone') return send(404, { message: 'Unknown Message', code: 10008 });
      hooks.push({ method: 'PATCH', msg: m[3], hook: m[1], body: JSON.parse(body) }); return send(200, {});
    }
    m = req.url.match(/^\/webhooks\/(\d+)\/([^/?]+)$/);   // webhook lookup when a channel is added
    if (req.method === 'GET' && m) return m[1] === '404' ? send(404, { message: 'Unknown Webhook', code: 10015 }) : send(200, { id: m[1], name: 'Hook ' + m[1], guild_id: m[1] === '997' ? 'G2' : 'G1' });
    if (req.method === 'PUT' && /^\/applications\/\d+\/commands$/.test(req.url)) { cmdPuts.push(JSON.parse(body)); return send(200, JSON.parse(body)); }
    if (req.method === 'GET' && req.url === '/guilds/G2/roles') return send(200, [{ id: 'G2', name: '@everyone', position: 0 }, { id: '6660000001', name: 'KON', position: 2 }]);
    if (req.method === 'GET' && /^\/guilds\/\w+\/roles$/.test(req.url)) {
      return send(200, [{ id: 'G1', name: '@everyone', position: 0 }, { id: '5551234567', name: 'Kongreso', position: 3, color: 15158332 }, { id: '5559876543', name: 'Senado', position: 2 }, { id: '77', name: 'SomeBot', managed: true, position: 1 }]);
    }
    if (req.method === 'GET' && /^\/guilds\/\w+$/.test(req.url)) return send(200, { name: 'Mock Guild ' + req.url.split('/').pop() });
    res.writeHead(404); res.end();
  });
});
await new Promise(r => mock.listen(8797, '127.0.0.1', r));

async function api(method, path, body, token) {
  const r = await fetch(W + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let d; try { d = await r.json(); } catch { d = {}; }
  return [r.status, d];
}
let tokN = 0;
async function interact(payload) {
  payload.token = payload.token || ('itok' + (++tokN));
  const body = JSON.stringify(payload); const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(ts + body), priv).toString('hex');
  const r = await fetch(W + '/discord/interactions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body });
  let d; try { d = await r.json(); } catch { d = {}; }
  return [r.status, d, payload.token];
}
const member = (who) => ({ nick: who.nick, user: { id: who.id, username: 'user' + who.id } });
async function run(name, options, who, guild = 'G1') {
  const [, , tok] = await interact({ type: 2, guild_id: guild, data: { name, options }, member: member(who) });
  for (let i = 0; i < 40 && !edits.has(tok); i++) await sleep(150);
  return edits.get(tok) || '';
}
const sql = (q) => execSync(`npx wrangler d1 execute guild-manager --local --json --command "${q.replace(/"/g, '\\"')}"`, { cwd: WORKER_DIR, shell: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
const rows = (q) => { const out = sql(q); return JSON.parse(out.slice(out.indexOf('[')))[0].results; };
const cron = () => fetch(W + '/__scheduled?cron=*+*+*+*+*').then(r => r.text());
// wait for the next schedule webhook call after index `from`
async function nextHook(from, pred = () => true, ms = 6000) {
  for (let t = 0; t < ms; t += 150) { const h = hooks.slice(from).find(pred); if (h) return h; await sleep(150); }
  return null;
}
const desc = (h) => h?.body?.embeds?.[0]?.description || '';
// stored message ids are per channel: { <webhook id>: <message id> }
const msgOf = (raw, hook) => { try { return JSON.parse(raw)?.[hook]; } catch { return undefined; } };
const tz = 'Asia/Manila';
const dayKey = (ts) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).format(new Date(ts));

// ---- setup: leader (officer+), member, a team with 3 preset bosses, server G1 linked
const [, la] = await api('POST', '/auth/guest', { username: 's_leader' }); const leader = la.token;
const [, ma] = await api('POST', '/auth/guest', { username: 's_member' }); const mem = ma.token;
const ids = {}; for (const [k, t] of [['leader', leader], ['member', mem]]) { const [, me] = await api('GET', '/auth/me', null, t); ids[k] = me.id; }
const LEADER = { id: '111', nick: 'Lead' }, MEMBER = { id: '222' };
sql(`UPDATE users SET discord_id='111', auth_type='discord' WHERE id='${ids.leader}'; UPDATE users SET discord_id='222', auth_type='discord' WHERE id='${ids.member}'`);
const [, tc] = await api('POST', '/api/teams', { name: 'Sched Guild' }, leader); const team = tc.id || tc.team?.id;
const [, td] = await api('GET', `/api/teams/${team}`, null, leader); const code = (td.team || td).invite_code;
await api('POST', `/api/invite/${code}`, {}, mem);
await api('POST', `/api/teams/${team}/bosses/presets`, { presetId: 'lordnine', names: ['Venatus', 'Viorent', 'Lady Dalia'] }, leader);
await api('PUT', `/api/teams/${team}/settings`, { timezone: tz }, leader);
check('setup: /link G1', /Linked this server/.test(await run('link', [{ name: 'code', value: code }], LEADER)));
const bossId = (name) => rows(`SELECT id FROM bosses WHERE team_id='${team}' AND name='${name}'`)[0].id;
const addHook = (kind, url, tok = leader) => api('POST', `/api/teams/${team}/webhooks`, { kind, url }, tok);
const dropHook = (kind, id) => api('DELETE', `/api/teams/${team}/webhooks/${kind}/${id}`, null, leader);
const ven = bossId('Venatus'), vio = bossId('Viorent'), dal = bossId('Lady Dalia');
// Preset timers land tomorrow when the suite runs in the evening, off today's post; pin the two bosses
// the assign checks read to a few minutes from now (still today unless run in the last minutes before midnight).
sql(`UPDATE bosses SET next_spawn = ${Date.now() + 5 * 60000}, status='waiting' WHERE id IN ('${ven}', '${vio}')`);

// ---- webhook setting
let [s, d] = await addHook('schedule', 'https://example.com/x');
check('non-Discord schedule webhook refused', s === 400, [s, d]);
[s] = await addHook('schedule', 'https://discord.com/api/webhooks/999/tokA', mem);
check('member cannot add a schedule channel', s === 403, s);
[s, d] = await addHook('schedule', 'https://discord.com/api/webhooks/404/tokX');
check('a webhook Discord does not know is refused', s === 400 && /does not know/.test(d.error || ''), [s, d]);
let mark = hooks.length;
[s, d] = await addHook('schedule', 'https://discord.com/api/webhooks/999/tokA');
let h = await nextHook(mark);
check('adding the channel posts today right away (webhook name kept)', s === 200 && d.name === 'Hook 999' && h?.method === 'POST' && h.hook === '999', [d, h]);
check('post is an embed titled team + weekday date, stamped with the edit time, no mentions parsed', /^Sched Guild · \w+day \d{1,2} \w+$/.test(h?.body?.embeds?.[0]?.title || '') && Math.abs(Date.parse(h?.body?.embeds?.[0]?.timestamp) - Date.now()) < 60000 && JSON.stringify(h?.body?.allowed_mentions) === '{"parse":[]}', h?.body);
let st = rows(`SELECT schedule_day, schedule_msg_id FROM team_settings WHERE team_id='${team}'`)[0];
check('message id + day stored', msgOf(st.schedule_msg_id, '999') === h?.msg && st.schedule_day === dayKey(Date.now()), st);
const msg1 = h?.msg;
[, d] = await api('GET', `/api/teams/${team}/settings`, null, leader);
check('settings list the channel by id + name (URL not leaked)', d.webhooks?.schedule?.length === 1 && d.webhooks.schedule[0].id === '999' && d.webhooks.schedule[0].name === 'Hook 999' && !JSON.stringify(d).includes('tokA'), d.webhooks);
[s, d] = await addHook('schedule', 'https://discord.com/api/webhooks/998/tokB');
check('free plan: a second schedule channel is Premium', s === 403 && d.premiumRequired === true, [s, d]);
[s, d] = await addHook('boss', 'https://discord.com/api/webhooks/601/b1');
check('free plan: boss alerts of their own are Premium', s === 403 && d.premiumRequired === true, [s, d]);

// ---- groups
[s, d] = await api('PUT', `/api/teams/${team}/settings`, { spawnGroups: [{ name: 'A' }, { name: 'a' }] }, leader);
check('duplicate group names refused', s === 400 && /Two groups/.test(d.error || ''), d);
[s] = await api('PUT', `/api/teams/${team}/settings`, { spawnGroups: [{ name: '@Kongreso', roleId: '5551234567' }, { name: 'Senado' }, ...Array.from({ length: 9 }, (_, i) => ({ name: 'G' + i }))] }, leader);
[, d] = await api('GET', `/api/teams/${team}/settings`, null, leader);
const groups = d.spawnGroups || [];
check('groups saved: max 8, leading @ stripped, role kept, ids assigned', s === 200 && groups.length === 8 && groups[0].name === 'Kongreso' && groups[1].roleId === null && groups.every(g => /^[a-z0-9]{4,12}$/.test(g.id)), groups.slice(0, 3));
check('a role saved the old way is filed under the linked server that has it', groups[0].roles?.G1 === '5551234567' && groups[0].roleId === null && JSON.stringify(groups[1].roles) === '{}', groups.slice(0, 2));
check('channels remember their server', d.webhooks.schedule[0].guildId === 'G1', d.webhooks.schedule);
const [KON, SEN] = groups.map(g => g.id);
[s] = await api('PUT', `/api/teams/${team}/settings`, { spawnGroups: groups.slice(0, 2).map((g, i) => i === 1 ? { ...g, name: 'Senado2' } : g) }, leader);
[, d] = await api('GET', `/api/teams/${team}/settings`, null, leader);
check('rename keeps the group id', d.spawnGroups.length === 2 && d.spawnGroups[1].id === SEN && d.spawnGroups[1].name === 'Senado2', d.spawnGroups);
await api('PUT', `/api/teams/${team}/settings`, { spawnGroups: [groups[0], { ...groups[1], name: 'Senado' }] }, leader);
[, d] = await api('GET', `/api/teams/${team}/bosses`, null, mem);
check('GET /bosses carries the groups (members too)', (d.groups || []).length === 2 && Array.isArray(d.bosses), d.groups);
[s, d] = await api('GET', `/api/teams/${team}/discord-roles`, null, leader);
const roles = d.servers?.[0]?.roles || [];
check('discord-roles: linked server roles minus @everyone and bot roles, top first', s === 200 && roles.map(r => r.name).join() === 'Kongreso,Senado', d);
[s] = await api('GET', `/api/teams/${team}/discord-roles`, null, mem);
check('discord-roles is officers+', s === 403, s);

// ---- assign from the site
[s] = await api('PUT', `/api/teams/${team}/bosses/${ven}/group`, { groupId: KON }, mem);
check('member cannot assign', s === 403, s);
[s] = await api('PUT', `/api/teams/${team}/bosses/${ven}/group`, { groupId: 'nope1234' }, leader);
check('unknown group refused', s === 400, s);
mark = hooks.length;
[s] = await api('PUT', `/api/teams/${team}/bosses/${ven}/group`, { groupId: KON }, leader);
h = await nextHook(mark, x => x.method === 'PATCH');
check('assigning edits the post in place with the role mention', s === 200 && h?.msg === msg1 && /Venatus.*<@&5551234567>/.test(desc(h)), desc(h));

// ---- spawn comes up (cron) -> UP
sql(`UPDATE bosses SET next_spawn = ${Date.now() - 60000}, status='waiting' WHERE id='${ven}'`);
mark = hooks.length; await cron();
h = await nextHook(mark, x => x.method === 'PATCH');
check('cron: spawned boss shows 🔴 up with a live Discord timestamp', /\*\*Venatus\*\*.*🔴 up <t:\d+:R>/.test(desc(h)), desc(h));

// ---- kill from the site -> crossed out, group kept on the line, cleared on the boss
mark = hooks.length;
[s] = await api('POST', `/api/teams/${team}/bosses/${ven}/kill`, { deathTime: Date.now() }, mem);
h = await nextHook(mark, x => x.method === 'PATCH');
check('site kill: line shrinks to grey, crossed out with ✓, group name kept', s === 200 && /^-# ~~`[^`]+` Venatus[^~\n]* · Kongreso~~ ✓$/m.test(desc(h)), desc(h));
check('site kill: group cleared for the next spawn', rows(`SELECT spawn_group FROM bosses WHERE id='${ven}'`)[0].spawn_group === null);
const rec = rows(`SELECT * FROM schedule_spawns WHERE boss_id='${ven}'`);
check('schedule_spawns row recorded (dead, group, today)', rec.length === 1 && rec[0].outcome === 'dead' && rec[0].group_id === KON && rec[0].day === dayKey(Date.now()), rec);

// ---- Discord /assign + /killed + /next
check('/assign by a member refused', /Only the leader or an officer/.test(await run('assign', [{ name: 'boss', value: vio }, { name: 'group', value: SEN }], MEMBER)));
mark = hooks.length;
let t = await run('assign', [{ name: 'boss', value: 'Viorent' }, { name: 'group', value: '@senado' }], LEADER);
h = await nextHook(mark, x => x.method === 'PATCH');
check('/assign by name works and edits the post', /\*\*Viorent\*\* next spawn \(.+\) → @Senado/.test(t) && /Viorent.*@Senado/.test(desc(h)), [t, desc(h)]);
check('/next shows the group tag', /\*\*Viorent\*\*[^\n]*@Senado/.test(await run('next', [{ name: 'count', value: 25 }], MEMBER)));
t = await run('assign', [{ name: 'boss', value: vio }, { name: 'group', value: 'none' }], LEADER);
check('/assign none clears', /no group/.test(t) && rows(`SELECT spawn_group FROM bosses WHERE id='${vio}'`)[0].spawn_group === null, t);
let [, ac] = await interact({ type: 4, guild_id: 'G1', data: { name: 'assign', options: [{ name: 'boss', value: vio }, { name: 'group', value: 'kon', focused: true }] }, member: member(LEADER) });
check('group autocomplete filters + offers clear', ac.data?.choices?.map(c => c.name).join('|') === 'Kongreso|No group (clear)', ac.data);
sql(`UPDATE bosses SET next_spawn = ${Date.now() - 120000}, status='spawned' WHERE id='${dal}'`);
mark = hooks.length;
t = await run('killed', [{ name: 'boss', value: 'Lady Dalia' }], MEMBER);
h = await nextHook(mark, x => x.method === 'PATCH');
check('/killed replies and crosses the line out', /Lady Dalia\*\* killed/.test(t) && /^-# ~~`[^`]+` Lady Dalia[^~\n]*~~ ✓$/m.test(desc(h)), [t, desc(h)]);

// ---- auto-reset (cron)
sql(`UPDATE bosses SET status='spawned', next_spawn=${Date.now() - 400000}, auto_reset_at=${Date.now() - 1000}, spawn_group='${SEN}' WHERE id='${vio}'`);
mark = hooks.length; await cron();
h = await nextHook(mark, x => x.method === 'PATCH');
check('auto-reset crosses the line out as auto-reset, with its group', /^-# ~~`[^`]+` Viorent[^~\n]* · Senado~~ ↺ auto-reset$/m.test(desc(h)), desc(h));
check('auto-reset recorded + group cleared', rows(`SELECT outcome FROM schedule_spawns WHERE boss_id='${vio}'`)[0]?.outcome === 'reset' && rows(`SELECT spawn_group FROM bosses WHERE id='${vio}'`)[0].spawn_group === null);

// ---- quiet cron minute: nothing changed -> no webhook traffic
mark = hooks.length; await cron(); await sleep(1500);
check('cron with no changes sends nothing', hooks.length === mark, hooks.slice(mark));

// ---- midnight rollover
sql(`UPDATE team_settings SET schedule_day='2000-01-01' WHERE team_id='${team}'`);
mark = hooks.length; await cron();
h = await nextHook(mark, x => x.method === 'POST');
st = rows(`SELECT schedule_day, schedule_msg_id, schedule_prev_day, schedule_prev_msg_id FROM team_settings WHERE team_id='${team}'`)[0];
check('rollover posts a new message and keeps the old one as prev', h && msgOf(st.schedule_msg_id, '999') === h.msg && msgOf(st.schedule_prev_msg_id, '999') === msg1 && st.schedule_prev_day === '2000-01-01' && st.schedule_day === dayKey(Date.now()), st);
const msg2 = h?.msg;
mark = hooks.length; await cron(); await sleep(1500);
check('no second post in the same day', !hooks.slice(mark).some(x => x.method === 'POST'));

// ---- late kill of yesterday's spawn edits yesterday's message too
const startToday = Date.parse(dayKey(Date.now()) + 'T00:00:00+08:00');
const yKey = dayKey(startToday - 3600000);
sql(`UPDATE team_settings SET schedule_prev_day='${yKey}', schedule_prev_msg_id='${msg1}' WHERE team_id='${team}'; UPDATE bosses SET status='spawned', next_spawn=${startToday - 30 * 60000} WHERE id='${dal}'`);
mark = hooks.length;
[s] = await api('POST', `/api/teams/${team}/bosses/${dal}/kill`, { deathTime: startToday - 20 * 60000 }, leader);
await nextHook(mark, x => x.msg === msg1, 6000);
const touched = hooks.slice(mark);
check("kill of last night's spawn edits yesterday's post (and today's)", touched.some(x => x.msg === msg1 && /Lady Dalia[^~\n]*~~ ✓/.test(desc(x))) && touched.some(x => x.msg === msg2), touched.map(x => [x.msg, x.method]));

// ---- message deleted in Discord -> fresh post
sql(`UPDATE team_settings SET schedule_msg_id='gone' WHERE team_id='${team}'`);
mark = hooks.length;
await api('PUT', `/api/teams/${team}/bosses/${ven}/group`, { groupId: SEN }, leader);
h = await nextHook(mark, x => x.method === 'POST');
check('deleted message is replaced by a new post (an id saved before channel lists counts as the first channel)', h && msgOf(rows(`SELECT schedule_msg_id FROM team_settings WHERE team_id='${team}'`)[0].schedule_msg_id, '999') === h.msg, h?.msg);

// ---- Discord down at midnight -> the day moves on, the channel's post is retried next minute
const schedRow = () => rows(`SELECT schedule_day, schedule_msg_id, schedule_prev_msg_id FROM team_settings WHERE team_id='${team}'`)[0];
sql(`UPDATE team_settings SET schedule_day='2000-01-02', schedule_msg_id='old1' WHERE team_id='${team}'`);
failPosts = true; await cron(); await sleep(1500);
st = schedRow();
check('failed rollover post: day rolled, yesterday kept, the channel left free to retry', st.schedule_day === dayKey(Date.now()) && st.schedule_prev_msg_id === 'old1' && msgOf(st.schedule_msg_id, '999') === undefined, st);
failPosts = false; mark = hooks.length; await cron();
h = await nextHook(mark, x => x.method === 'POST');
check('retried on the next cron minute', !!h && msgOf(schedRow().schedule_msg_id, '999') === h.msg);

// ---- webhook refused (4xx) -> marked, not retried every minute; adding the channel again retries
sql(`UPDATE team_settings SET schedule_msg_id='{}' WHERE team_id='${team}'`);
failPosts = 'perm'; await cron(); await sleep(1500);
check('refused post: channel marked as refused', msgOf(schedRow().schedule_msg_id, '999') === '', schedRow());
failPosts = false; mark = hooks.length; await cron(); await sleep(1500);
check('refused post: not retried by the cron', !hooks.slice(mark).some(x => x.method === 'POST'), hooks.slice(mark));
mark = hooks.length;
[s] = await addHook('schedule', 'https://discord.com/api/webhooks/999/tokA');
h = await nextHook(mark, x => x.method === 'POST');
check('adding the same channel again posts again', s === 200 && h?.hook === '999' && msgOf(schedRow().schedule_msg_id, '999') === h.msg, [s, h, schedRow()]);

// ---- Premium: up to 3 schedule channels, each with its own message
sql(`UPDATE users SET premium = 1 WHERE id='${ids.leader}'`);
{
  const m999 = msgOf(schedRow().schedule_msg_id, '999');
  mark = hooks.length;
  [s] = await addHook('schedule', 'https://discord.com/api/webhooks/998/tokB');
  h = await nextHook(mark, x => x.method === 'POST');
  await sleep(800);
  check('second channel: today posted there only', s === 200 && h?.hook === '998' && hooks.slice(mark).filter(x => x.method === 'POST').length === 1 && msgOf(schedRow().schedule_msg_id, '998') === h.msg && msgOf(schedRow().schedule_msg_id, '999') === m999, [s, hooks.slice(mark), schedRow()]);
  [s] = await addHook('schedule', 'https://discord.com/api/webhooks/997/tokC');
  await nextHook(mark, x => x.method === 'POST' && x.hook === '997');
  [s, d] = await addHook('schedule', 'https://discord.com/api/webhooks/996/tokD');
  check('a fourth channel is refused', s === 403 && /Up to 3/.test(d.error || '') && !d.premiumRequired, [s, d]);
  [, d] = await api('GET', `/api/teams/${team}/settings`, null, leader);
  check('settings list all three channels', d.webhooks.schedule.map(x => x.id).join() === '999,998,997', d.webhooks.schedule);
  mark = hooks.length;
  await api('PUT', `/api/teams/${team}/bosses/${ven}/group`, { groupId: KON }, leader);
  await nextHook(mark, x => x.hook === '997' && x.method === 'PATCH'); await sleep(800);
  let edited = hooks.slice(mark).filter(x => x.method === 'PATCH').map(x => x.hook).sort().join();
  check('a change edits the post in every channel, no new posts', edited === '997,998,999' && !hooks.slice(mark).some(x => x.method === 'POST'), hooks.slice(mark));
  [s] = await dropHook('schedule', '998');
  check('removing a channel drops its message id only', s === 200 && msgOf(schedRow().schedule_msg_id, '998') === undefined && msgOf(schedRow().schedule_msg_id, '999') === m999, schedRow());
  mark = hooks.length;
  await api('PUT', `/api/teams/${team}/bosses/${ven}/group`, { groupId: SEN }, leader);
  await nextHook(mark, x => x.hook === '997' && x.method === 'PATCH'); await sleep(800);
  edited = hooks.slice(mark).map(x => x.hook).sort().join();
  check('removed channel is no longer touched', edited === '997,999', hooks.slice(mark));
  [s] = await dropHook('schedule', '998');
  check('removing an unknown channel: 404', s === 404, s);
}

// ---- two servers: each schedule channel shows the group roles of its own server
{
  check('/link a second server G2', /Linked this server/.test(await run('link', [{ name: 'code', value: code }], LEADER, 'G2')));
  [, d] = await api('GET', `/api/teams/${team}/settings`, null, leader);
  const byId = Object.fromEntries(d.webhooks.schedule.map(x => [x.id, x.guildId]));
  check('schedule channels: 999 in G1, 997 in G2', byId['999'] === 'G1' && byId['997'] === 'G2', d.webhooks.schedule);
  const gs = d.spawnGroups.map(g => g.id === KON ? { ...g, roles: { G1: '5551234567', G2: '6660000001' } } : g);
  [s] = await api('PUT', `/api/teams/${team}/settings`, { spawnGroups: gs }, leader);
  [, d] = await api('GET', `/api/teams/${team}/settings`, null, leader);
  check('a role per server saved', s === 200 && JSON.stringify(d.spawnGroups.find(g => g.id === KON).roles) === JSON.stringify({ G1: '5551234567', G2: '6660000001' }), d.spawnGroups);
  mark = hooks.length;
  await api('PUT', `/api/teams/${team}/bosses/${ven}/group`, { groupId: KON }, leader);
  await nextHook(mark, x => x.hook === '997' && x.method === 'PATCH'); await nextHook(mark, x => x.hook === '999' && x.method === 'PATCH'); await sleep(500);
  const ed = (hk) => hooks.slice(mark).filter(x => x.hook === hk && x.method === 'PATCH').map(desc).find(t => /Venatus/.test(t)) || '';
  check('G1 channel: Kongreso shows G1\'s role', /Venatus.*<@&5551234567>/.test(ed('999')) && !ed('999').includes('6660000001'), ed('999'));
  check('G2 channel: Kongreso shows G2\'s role', /Venatus.*<@&6660000001>/.test(ed('997')) && !ed('997').includes('5551234567'), ed('997'));
  await api('PUT', `/api/teams/${team}/bosses/${vio}/group`, { groupId: SEN }, leader); await sleep(1500);
  const sen = hooks.filter(x => x.hook === '997' && x.method === 'PATCH').map(desc).at(-1) || '';
  check('G2 channel: a group with no role there shows as plain @Name', /Viorent.*@Senado/.test(sen), sen);
  const n1 = await run('next', [{ name: 'count', value: 25 }], MEMBER, 'G1'), n2 = await run('next', [{ name: 'count', value: 25 }], MEMBER, 'G2');
  check('/next uses the roles of the server it is typed in', /Venatus.*<@&5551234567>/.test(n1) && /Venatus.*<@&6660000001>/.test(n2), [n1.slice(0, 300), n2.slice(0, 300)]);
  const as = await run('assign', [{ name: 'boss', value: ven }, { name: 'group', value: KON }], LEADER, 'G2');
  check('/assign replies with the role of its server', /<@&6660000001>/.test(as), as);
  [, d] = await api('GET', `/api/teams/${team}/discord-roles`, null, leader);
  check('discord-roles lists both servers', d.servers?.length === 2 && d.servers.some(x => x.guildId === 'G2' && x.roles.map(r => r.name).join() === 'KON'), d.servers);
}

// ---- boss alerts: two messages per spawn, edited in place (lib/boss-alerts.js)
{
  await addHook('url', 'https://discord.com/api/webhooks/555/alertTok');
  await api('PUT', `/api/teams/${team}/settings`, { onWarning: true, onSpawn: true }, leader);
  const [, ab] = await api('POST', `/api/teams/${team}/bosses`, { name: 'Alert Boss', type: 'interval', intervalMs: 3600000 }, leader);
  const A = ab.id;
  const al = (from) => hooks.slice(from).filter(h => h.hook === '555');
  const aRow = () => rows(`SELECT alert_soon_msg, alert_spawn_msg FROM bosses WHERE id='${A}'`)[0];
  const title = (h) => h?.body?.embeds?.[0]?.title || '';
  const soonThenUp = async () => {
    sql(`UPDATE bosses SET status='waiting', warned=0, spawn_notified=0, next_spawn=${Date.now() + 120000} WHERE id='${A}'`);
    let m0 = hooks.length; await cron();
    const soon = await nextHook(m0, h => h.hook === '555' && h.method === 'POST');
    sql(`UPDATE bosses SET next_spawn=${Date.now() - 1000} WHERE id='${A}'`);
    m0 = hooks.length; await cron();
    const up = await nextHook(m0, h => h.hook === '555' && h.method === 'POST');
    await nextHook(m0, h => h.hook === '555' && h.method === 'PATCH' && h.msg === soon?.msg, 3000);
    return { soon, up, m0 };
  };

  let m = hooks.length; await cron();   // not due yet: nothing
  let { soon, up, m0 } = await soonThenUp();
  check('alert 1: "spawning soon" posted and its id kept', /Alert Boss — spawning soon/.test(title(soon)), title(soon));
  const shrink = al(m0).find(h => h.method === 'PATCH' && h.msg === soon?.msg);
  check('alert 2: "has spawned" posted; the soon message shrinks to one grey line', /Alert Boss has spawned/.test(title(up)) && /^-# ⏰ Alert Boss spawned at /.test(shrink?.body?.content || '') && shrink?.body?.embeds?.length === 0, [title(up), shrink?.body]);
  check('a normal spawn auto-resets after its own 5 minutes', rows(`SELECT auto_reset_at - spawned_at AS w FROM bosses WHERE id='${A}'`)[0].w === 5 * 60000, rows(`SELECT auto_reset_at, spawned_at FROM bosses WHERE id='${A}'`));
  check('spawn message id stored, soon id cleared', msgOf(aRow().alert_spawn_msg, '555') === up?.msg && aRow().alert_soon_msg === null, aRow());
  m = hooks.length;
  await api('POST', `/api/teams/${team}/bosses/${A}/kill`, {}, leader);
  let ed = await nextHook(m, h => h.hook === '555' && h.method === 'PATCH' && h.msg === up?.msg);
  check('kill from the site edits the spawned message to "killed by <name>", no new message', /☠️ Alert Boss — killed/.test(title(ed)) && /by \*\*s_leader\*\*/.test(ed?.body?.embeds?.[0]?.description || '') && !al(m).some(h => h.method === 'POST'), ed?.body);
  check('kill clears the alert ids', aRow().alert_spawn_msg === null && aRow().alert_soon_msg === null, aRow());

  ({ soon, up } = await soonThenUp());
  sql(`UPDATE bosses SET auto_reset_at=${Date.now() - 1000} WHERE id='${A}'`);
  m = hooks.length; await cron();
  ed = await nextHook(m, h => h.hook === '555' && h.method === 'PATCH' && h.msg === up?.msg);
  check('auto-reset edits the spawned message, no new message', /⏱ Alert Boss — auto-reset/.test(title(ed)) && !al(m).some(h => h.method === 'POST') && aRow().alert_spawn_msg === null, [title(ed), al(m).map(h => h.method)]);

  sql(`UPDATE bosses SET status='waiting', warned=0, spawn_notified=0, next_spawn=${Date.now() + 120000} WHERE id='${A}'`);
  m = hooks.length; await cron();
  soon = await nextHook(m, h => h.hook === '555' && h.method === 'POST');
  m = hooks.length;
  const kt = await run('killed', [{ name: 'boss', value: 'Alert Boss' }], MEMBER);
  ed = await nextHook(m, h => h.hook === '555' && h.method === 'PATCH' && h.msg === soon?.msg);
  check('killed before it spawned (/killed): the soon message becomes "killed"', /killed/.test(kt) && /☠️ Alert Boss — killed/.test(title(ed)) && /by \*\*user222\*\*|by \*\*Global222\*\*|by \*\*/.test(ed?.body?.embeds?.[0]?.description || ''), [kt, ed?.body]);

  await api('PUT', `/api/teams/${team}/settings`, { onSpawn: false }, leader);
  sql(`UPDATE bosses SET status='waiting', warned=0, spawn_notified=0, next_spawn=${Date.now() + 120000} WHERE id='${A}'`);
  m = hooks.length; await cron();
  soon = await nextHook(m, h => h.hook === '555' && h.method === 'POST');
  sql(`UPDATE bosses SET next_spawn=${Date.now() - 1000} WHERE id='${A}'`);
  m = hooks.length; await cron();
  ed = await nextHook(m, h => h.hook === '555' && h.method === 'PATCH' && h.msg === soon?.msg);
  await sleep(500);
  check('spawn alerts off: no new message; the soon message quietly turns into "has spawned"', /Alert Boss has spawned/.test(title(ed)) && !al(m).some(h => h.method === 'POST') && msgOf(aRow().alert_spawn_msg, '555') === soon?.msg, [title(ed), aRow()]);
  await api('PUT', `/api/teams/${team}/settings`, { onSpawn: true }, leader);
  await dropHook('url', '555');
  await api('DELETE', `/api/teams/${team}/bosses/${A}`, null, leader);
}

// ---- boss alerts in two channels of their own (Premium): each channel gets and edits its own messages
{
  await addHook('url', 'https://discord.com/api/webhooks/555/alertTok');
  await addHook('boss', 'https://discord.com/api/webhooks/601/b1');
  await addHook('boss', 'https://discord.com/api/webhooks/602/b2');
  const [, mb] = await api('POST', `/api/teams/${team}/bosses`, { name: 'Multi Boss', type: 'interval', intervalMs: 3600000 }, leader);
  const B = mb.id;
  const bRow = () => rows(`SELECT alert_soon_msg, alert_spawn_msg FROM bosses WHERE id='${B}'`)[0];
  const both = async (from, method, pred = () => true) => {
    for (let t = 0; t < 6000; t += 150) {
      const got = hooks.slice(from).filter(x => x.method === method && ['601', '602'].includes(x.hook) && pred(x));
      if (new Set(got.map(x => x.hook)).size === 2) return Object.fromEntries(got.map(x => [x.hook, x]));
      await sleep(150);
    }
    return {};
  };
  sql(`UPDATE bosses SET status='waiting', warned=0, spawn_notified=0, next_spawn=${Date.now() + 120000} WHERE id='${B}'`);
  let m = hooks.length; await cron();
  const soon = await both(m, 'POST');
  await sleep(500);
  check('two boss channels: "spawning soon" in each, none in the main channel', soon['601'] && soon['602'] && !hooks.slice(m).some(x => x.hook === '555'), hooks.slice(m).map(x => x.hook));
  check('two boss channels: soon ids kept per channel', msgOf(bRow().alert_soon_msg, '601') === soon['601']?.msg && msgOf(bRow().alert_soon_msg, '602') === soon['602']?.msg, bRow());
  sql(`UPDATE bosses SET next_spawn=${Date.now() - 1000} WHERE id='${B}'`);
  m = hooks.length; await cron();
  const up = await both(m, 'POST');
  const shrunk = await both(m, 'PATCH', x => x.msg === soon[x.hook]?.msg);
  await sleep(500);
  check('two boss channels: spawned posted in each and each soon message shrunk', up['601'] && up['602'] && shrunk['601'] && shrunk['602'], hooks.slice(m).map(x => [x.hook, x.method, x.msg]));
  check('two boss channels: spawn ids kept per channel', msgOf(bRow().alert_spawn_msg, '601') === up['601']?.msg && msgOf(bRow().alert_spawn_msg, '602') === up['602']?.msg, bRow());
  m = hooks.length;
  await api('POST', `/api/teams/${team}/bosses/${B}/kill`, {}, leader);
  const killed = await both(m, 'PATCH', x => x.msg === up[x.hook]?.msg && /killed/.test(x.body?.embeds?.[0]?.title || ''));
  check('two boss channels: the kill edits the spawned message in each', killed['601'] && killed['602'], hooks.slice(m).map(x => [x.hook, x.method]));
  await dropHook('boss', '601'); await dropHook('boss', '602'); await dropHook('url', '555');
  await api('DELETE', `/api/teams/${team}/bosses/${B}`, null, leader);
}

// ---- per-spawn groups: projected repeat spawns, later groups, alternation
{
  const [, db] = await api('POST', `/api/teams/${team}/bosses`, { name: 'Quickling', type: 'interval', intervalMs: 3600000 }, leader);
  const Q = db.id;
  const qRow = () => rows(`SELECT spawn_group, later_groups, alternate_groups FROM bosses WHERE id='${Q}'`)[0];
  const K = '<@&5551234567>', S = '@Senado';
  const qLines = (t) => t.split('\n').filter(l => /Quickling/.test(l));
  sql(`UPDATE bosses SET next_spawn=${Date.now() + 30 * 60000} WHERE id='${Q}'`);
  let [s1, d1] = await api('PUT', `/api/teams/${team}/bosses/${Q}/group`, { groups: [KON, SEN, null], alternate: false }, leader);
  check('groups dialog save: next + 2nd stored', s1 === 200 && qRow().spawn_group === KON && JSON.parse(qRow().later_groups)[0] === SEN, [s1, d1, qRow()]);
  [s1] = await api('PUT', `/api/teams/${team}/bosses/${Q}/group`, { groups: ['nope1234'] }, leader);
  check('unknown group in the list refused', s1 === 400, s1);
  let nx = qLines(await run('next', [{ name: 'count', value: 25 }], MEMBER));
  check('/next shows the repeat spawns of a short-timer boss, each with its own group', nx.length >= 3 && nx[0].includes(K) && nx[1].includes(S) && !nx[2].includes('@'), nx);

  await api('POST', `/api/teams/${team}/bosses/${Q}/kill`, {}, leader);
  check('kill: the 2nd spawn\'s group becomes the next one', qRow().spawn_group === SEN && qRow().later_groups === null, qRow());

  await api('PUT', `/api/teams/${team}/bosses/${Q}/group`, { groups: [KON], alternate: true }, leader);
  nx = qLines(await run('next', [{ name: 'count', value: 25 }], MEMBER));
  check('alternate on: projected spawns cycle Kongreso -> Senado -> Kongreso', nx[0].includes(K) && nx[1].includes(S) && nx[2].includes(K), nx.slice(0, 3));
  await api('POST', `/api/teams/${team}/bosses/${Q}/kill`, {}, leader);
  check('alternate on: after the kill the next spawn goes to the next group', qRow().spawn_group === SEN, qRow());
  await api('PUT', `/api/teams/${team}/bosses/${Q}/group`, { groups: [KON, KON], alternate: true }, leader);
  await api('POST', `/api/teams/${team}/bosses/${Q}/kill`, {}, leader);
  check('an officer pick beats alternation', qRow().spawn_group === KON, qRow());

  let t = await run('assign', [{ name: 'boss', value: Q }, { name: 'group', value: SEN }, { name: 'spawn', value: 2 }], LEADER);
  check('/assign spawn:2 sets the 2nd spawn only', /2nd spawn .* → @Senado/.test(t) && qRow().spawn_group === KON && JSON.parse(qRow().later_groups)[0] === SEN, [t, qRow()]);

  sql(`UPDATE bosses SET status='spawned', next_spawn=${Date.now() - 400000}, auto_reset_at=${Date.now() - 1000} WHERE id='${Q}'`);
  await cron(); await sleep(800);
  check('auto-reset moves the list up too', qRow().spawn_group === SEN, qRow());

  const [, imp] = await api('POST', `/api/teams/${team}/bosses/import-schedule`, { items: [{ bossId: Q, nextSpawn: Date.now() + 3600000, groupId: KON, laterGroups: [SEN, null, 'bogus'] }] }, leader);
  check('screenshot import sets the later spawns\' groups (unknown ids dropped)', imp.updated?.length === 1 && qRow().spawn_group === KON && qRow().later_groups === JSON.stringify([SEN]), [imp, qRow()]);
  await api('DELETE', `/api/teams/${team}/bosses/${Q}`, null, leader);
}

// ---- maintenance reset: every interval timer to server open, fixed ones untouched, ONE alert message
{
  await addHook('url', 'https://discord.com/api/webhooks/555/alertTok');
  await api('PUT', `/api/teams/${team}/settings`, { onWarning: true, onSpawn: true }, leader);
  const [, fx] = await api('POST', `/api/teams/${team}/bosses`, { name: 'Fixed Boss', type: 'fixed', fixedTime: '21:00' }, leader);
  const fixedAt = () => rows(`SELECT next_spawn FROM bosses WHERE id='${fx.id}'`)[0].next_spawn;
  const fixedBefore = fixedAt();
  const interval = () => rows(`SELECT name, next_spawn, status, warned, spawn_notified FROM bosses WHERE team_id='${team}' AND type='interval'`);
  const url = `/api/teams/${team}/bosses/maintenance-reset`;
  let [s1] = await api('POST', url, {}, mem);
  check('maintenance reset: members refused', s1 === 403, s1);
  [s1] = await api('POST', url, { openAt: Date.now() + 3 * 86400000 }, leader);
  check('maintenance reset: open time 3 days out refused', s1 === 400, s1);

  const openAt = Date.now() - 60000;
  let m = hooks.length;
  const [s2, r2] = await api('POST', url, { openAt }, leader);
  const iv = interval();
  check('maintenance reset: every interval timer set to the open time, per-boss alerts muted', s2 === 200 && iv.length >= 2 && r2.reset === iv.length && iv.every(b => b.next_spawn === openAt && b.status === 'waiting' && b.warned === 1 && b.spawn_notified === 1), [s2, r2, iv]);
  check('maintenance reset: fixed-schedule boss keeps its time', fixedAt() === fixedBefore && r2.kept >= 1, [fixedBefore, fixedAt(), r2]);
  const sum = await nextHook(m, h => h.hook === '555' && h.method === 'POST');
  check('maintenance reset: one summary message in the alert channel', /Maintenance reset/.test(sum?.body?.embeds?.[0]?.title || '') && new RegExp(`\\*\\*${r2.reset} bosses\\*\\* spawn now`).test(sum?.body?.embeds?.[0]?.description || '') && /wait 30 minutes before they auto-reset/.test(sum?.body?.embeds?.[0]?.description || ''), sum?.body);

  m = hooks.length; await cron(); await sleep(1500);
  const up = interval();
  const waits = rows(`SELECT auto_reset_at - spawned_at AS w FROM bosses WHERE team_id='${team}' AND type='interval'`).map(r => r.w);
  check('maintenance reset: the bosses it brought up wait 30 minutes before auto-reset (clearing them all takes a while)', waits.length && waits.every(w => w === 30 * 60000), waits);
  check('maintenance reset: cron brings them all up with no per-boss pings', up.every(b => b.status === 'spawned') && !hooks.slice(m).some(h => h.hook === '555' && h.method === 'POST'), [up.map(b => b.status), hooks.slice(m).map(h => [h.hook, h.method])]);
  await api('DELETE', `/api/teams/${team}/bosses/${fx.id}`, null, leader);
}

// ---- remove every schedule channel -> quiet
[, d] = await api('GET', `/api/teams/${team}/settings`, null, leader);
for (const x of d.webhooks.schedule) await dropHook('schedule', x.id);
check('last schedule channel removed: post state cleared', schedRow().schedule_day === null && schedRow().schedule_msg_id === null, schedRow());
mark = hooks.length;
await api('POST', `/api/teams/${team}/bosses/${vio}/kill`, {}, leader); await cron(); await sleep(1500);
check('removed webhook: no more posts or edits', hooks.length === mark, hooks.slice(mark));

// ---- slash commands registered by the cron itself (no token on the user's PC)
const reg = rows(`SELECT value FROM app_state WHERE key='discord_commands'`)[0];
check('cron registered the slash commands exactly once, incl. /assign', cmdPuts.length === 1 && cmdPuts[0].length === 7 && cmdPuts[0].some(c => c.name === 'assign') && reg && JSON.parse(reg.value).length === 7, [cmdPuts.length, reg?.value?.slice(0, 80)]);

// ---- team delete still works (schedule_spawns cleared)
[s, d] = await api('DELETE', `/api/teams/${team}`, null, leader);
check('team delete works with schedule rows present', s === 200 && rows(`SELECT COUNT(*) AS n FROM schedule_spawns WHERE team_id='${team}'`)[0].n === 0, [s, d]);

console.log(`${checks.filter(Boolean).length}/${checks.length} checks passed`);
mock.close();
process.exitCode = checks.every(Boolean) ? 0 : 1;
