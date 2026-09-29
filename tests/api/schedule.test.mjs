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
      if (failPosts) return send(500, { message: 'boom' });
      const id = 'm' + (++msgN); hooks.push({ method: 'POST', msg: id, hook: m[1], body: JSON.parse(body) }); return send(200, { id });
    }
    m = req.url.match(/^\/webhooks\/(\d+)\/([^/?]+)\/messages\/(\w+)$/);
    if (req.method === 'PATCH' && m) {
      if (m[3] === 'gone') return send(404, { message: 'Unknown Message', code: 10008 });
      hooks.push({ method: 'PATCH', msg: m[3], hook: m[1], body: JSON.parse(body) }); return send(200, {});
    }
    if (req.method === 'PUT' && /^\/applications\/\d+\/commands$/.test(req.url)) { cmdPuts.push(JSON.parse(body)); return send(200, JSON.parse(body)); }
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
const ven = bossId('Venatus'), vio = bossId('Viorent'), dal = bossId('Lady Dalia');
// Preset timers land tomorrow when the suite runs in the evening, off today's post; pin the two bosses
// the assign checks read to a few minutes from now (still today unless run in the last minutes before midnight).
sql(`UPDATE bosses SET next_spawn = ${Date.now() + 5 * 60000}, status='waiting' WHERE id IN ('${ven}', '${vio}')`);

// ---- webhook setting
let [s, d] = await api('PUT', `/api/teams/${team}/settings`, { webhookSchedule: 'https://example.com/x' }, leader);
check('non-Discord schedule webhook refused', s === 400, [s, d]);
[s] = await api('PUT', `/api/teams/${team}/settings`, { webhookSchedule: 'https://discord.com/api/webhooks/999/tokA' }, mem);
check('member cannot set the schedule webhook', s === 403, s);
let mark = hooks.length;
[s] = await api('PUT', `/api/teams/${team}/settings`, { webhookSchedule: 'https://discord.com/api/webhooks/999/tokA' }, leader);
let h = await nextHook(mark);
check('saving the webhook posts today right away', s === 200 && h?.method === 'POST' && h.hook === '999', h);
check('post is an embed titled team + date, no mentions parsed', /^Sched Guild — \d{1,2} \w+ \d{4}$/.test(h?.body?.embeds?.[0]?.title || '') && JSON.stringify(h?.body?.allowed_mentions) === '{"parse":[]}', h?.body);
let st = rows(`SELECT schedule_day, schedule_msg_id FROM team_settings WHERE team_id='${team}'`)[0];
check('message id + day stored', st.schedule_msg_id === h?.msg && st.schedule_day === dayKey(Date.now()), st);
const msg1 = h?.msg;
[, d] = await api('GET', `/api/teams/${team}/settings`, null, leader);
check('settings report webhookScheduleSet (URL not leaked)', d.webhookScheduleSet === true && !JSON.stringify(d).includes('tokA'), d.webhookScheduleSet);

// ---- groups
[s, d] = await api('PUT', `/api/teams/${team}/settings`, { spawnGroups: [{ name: 'A' }, { name: 'a' }] }, leader);
check('duplicate group names refused', s === 400 && /Two groups/.test(d.error || ''), d);
[s] = await api('PUT', `/api/teams/${team}/settings`, { spawnGroups: [{ name: '@Kongreso', roleId: '5551234567' }, { name: 'Senado' }, ...Array.from({ length: 9 }, (_, i) => ({ name: 'G' + i }))] }, leader);
[, d] = await api('GET', `/api/teams/${team}/settings`, null, leader);
const groups = d.spawnGroups || [];
check('groups saved: max 8, leading @ stripped, role kept, ids assigned', s === 200 && groups.length === 8 && groups[0].name === 'Kongreso' && groups[0].roleId === '5551234567' && groups[1].roleId === null && groups.every(g => /^[a-z0-9]{4,12}$/.test(g.id)), groups.slice(0, 3));
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
check('cron: spawned boss shows 🔴 UP on the post', /Venatus.*🔴 UP/.test(desc(h)), desc(h));

// ---- kill from the site -> crossed out, group kept on the line, cleared on the boss
mark = hooks.length;
[s] = await api('POST', `/api/teams/${team}/bosses/${ven}/kill`, { deathTime: Date.now() }, mem);
h = await nextHook(mark, x => x.method === 'PATCH');
check('site kill: line crossed out with "dead", group tag kept', s === 200 && /~~`[^`]+` \| Venatus \| <@&5551234567>~~ — dead/.test(desc(h)), desc(h));
check('site kill: group cleared for the next spawn', rows(`SELECT spawn_group FROM bosses WHERE id='${ven}'`)[0].spawn_group === null);
const rec = rows(`SELECT * FROM schedule_spawns WHERE boss_id='${ven}'`);
check('schedule_spawns row recorded (dead, group, today)', rec.length === 1 && rec[0].outcome === 'dead' && rec[0].group_id === KON && rec[0].day === dayKey(Date.now()), rec);

// ---- Discord /assign + /killed + /next
check('/assign by a member refused', /Only the leader or an officer/.test(await run('assign', [{ name: 'boss', value: vio }, { name: 'group', value: SEN }], MEMBER)));
mark = hooks.length;
let t = await run('assign', [{ name: 'boss', value: 'Viorent' }, { name: 'group', value: '@senado' }], LEADER);
h = await nextHook(mark, x => x.method === 'PATCH');
check('/assign by name works and edits the post', /\*\*Viorent\*\* next spawn \(.+\) → @Senado/.test(t) && /Viorent.*@Senado/.test(desc(h)), [t, desc(h)]);
check('/next shows the group tag', /Viorent \|[^\n]*@Senado/.test(await run('next', [{ name: 'count', value: 25 }], MEMBER)));
t = await run('assign', [{ name: 'boss', value: vio }, { name: 'group', value: 'none' }], LEADER);
check('/assign none clears', /no group/.test(t) && rows(`SELECT spawn_group FROM bosses WHERE id='${vio}'`)[0].spawn_group === null, t);
let [, ac] = await interact({ type: 4, guild_id: 'G1', data: { name: 'assign', options: [{ name: 'boss', value: vio }, { name: 'group', value: 'kon', focused: true }] }, member: member(LEADER) });
check('group autocomplete filters + offers clear', ac.data?.choices?.map(c => c.name).join('|') === 'Kongreso|No group (clear)', ac.data);
sql(`UPDATE bosses SET next_spawn = ${Date.now() - 120000}, status='spawned' WHERE id='${dal}'`);
mark = hooks.length;
t = await run('killed', [{ name: 'boss', value: 'Lady Dalia' }], MEMBER);
h = await nextHook(mark, x => x.method === 'PATCH');
check('/killed replies and crosses the line out', /Lady Dalia\*\* killed/.test(t) && /~~`[^`]+` \| Lady Dalia~~ — dead/.test(desc(h)), [t, desc(h)]);

// ---- auto-reset (cron)
sql(`UPDATE bosses SET status='spawned', next_spawn=${Date.now() - 400000}, auto_reset_at=${Date.now() - 1000}, spawn_group='${SEN}' WHERE id='${vio}'`);
mark = hooks.length; await cron();
h = await nextHook(mark, x => x.method === 'PATCH');
check('auto-reset crosses the line out as auto-reset, with its group', /~~`[^`]+` \| Viorent[^~]*@Senado~~ — auto-reset/.test(desc(h)), desc(h));
check('auto-reset recorded + group cleared', rows(`SELECT outcome FROM schedule_spawns WHERE boss_id='${vio}'`)[0]?.outcome === 'reset' && rows(`SELECT spawn_group FROM bosses WHERE id='${vio}'`)[0].spawn_group === null);

// ---- quiet cron minute: nothing changed -> no webhook traffic
mark = hooks.length; await cron(); await sleep(1500);
check('cron with no changes sends nothing', hooks.length === mark, hooks.slice(mark));

// ---- midnight rollover
sql(`UPDATE team_settings SET schedule_day='2000-01-01' WHERE team_id='${team}'`);
mark = hooks.length; await cron();
h = await nextHook(mark, x => x.method === 'POST');
st = rows(`SELECT schedule_day, schedule_msg_id, schedule_prev_day, schedule_prev_msg_id FROM team_settings WHERE team_id='${team}'`)[0];
check('rollover posts a new message and keeps the old one as prev', h && st.schedule_msg_id === h.msg && st.schedule_prev_msg_id === msg1 && st.schedule_prev_day === '2000-01-01' && st.schedule_day === dayKey(Date.now()), st);
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
check("kill of last night's spawn edits yesterday's post (and today's)", touched.some(x => x.msg === msg1 && /Lady Dalia~~ — dead/.test(desc(x))) && touched.some(x => x.msg === msg2), touched.map(x => [x.msg, x.method]));

// ---- message deleted in Discord -> fresh post
sql(`UPDATE team_settings SET schedule_msg_id='gone' WHERE team_id='${team}'`);
mark = hooks.length;
await api('PUT', `/api/teams/${team}/bosses/${ven}/group`, { groupId: SEN }, leader);
h = await nextHook(mark, x => x.method === 'POST');
check('deleted message is replaced by a new post', h && rows(`SELECT schedule_msg_id FROM team_settings WHERE team_id='${team}'`)[0].schedule_msg_id === h.msg, h?.msg);

// ---- Discord down at midnight -> day handed back, retried next minute
sql(`UPDATE team_settings SET schedule_day='2000-01-02', schedule_msg_id='old1' WHERE team_id='${team}'`);
failPosts = true; await cron(); await sleep(1500);
st = rows(`SELECT schedule_day, schedule_msg_id FROM team_settings WHERE team_id='${team}'`)[0];
check('failed rollover post hands the day back', st.schedule_day === '2000-01-02' && st.schedule_msg_id === 'old1', st);
failPosts = false; mark = hooks.length; await cron();
h = await nextHook(mark, x => x.method === 'POST');
check('retried on the next cron minute', !!h && rows(`SELECT schedule_msg_id FROM team_settings WHERE team_id='${team}'`)[0].schedule_msg_id === h.msg);

// ---- boss alerts: two messages per spawn, edited in place (lib/boss-alerts.js)
{
  await api('PUT', `/api/teams/${team}/settings`, { webhookUrl: 'https://discord.com/api/webhooks/555/alertTok', onWarning: true, onSpawn: true }, leader);
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
  check('spawn message id stored, soon id cleared', aRow().alert_spawn_msg === up?.msg && aRow().alert_soon_msg === null, aRow());
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
  check('spawn alerts off: no new message; the soon message quietly turns into "has spawned"', /Alert Boss has spawned/.test(title(ed)) && !al(m).some(h => h.method === 'POST') && aRow().alert_spawn_msg === soon?.msg, [title(ed), aRow()]);
  await api('PUT', `/api/teams/${team}/settings`, { onSpawn: true, webhookUrl: '' }, leader);
  await api('DELETE', `/api/teams/${team}/bosses/${A}`, null, leader);
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

// ---- remove webhook -> quiet
await api('PUT', `/api/teams/${team}/settings`, { webhookSchedule: '' }, leader);
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
