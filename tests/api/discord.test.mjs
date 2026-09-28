// M13 Discord interactions test against `wrangler dev --local` (8788).
// Signs requests with the test Ed25519 key (private PEM path = argv[2]; its public half is in
// worker/.dev.vars). Runs a mock Discord API on 8797 that records the deferred follow-ups
// (PATCH …/messages/@original) so the command text can be asserted.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import http from 'node:http';

const W = 'http://127.0.0.1:8788';
const WORKER_DIR = process.argv[3];
const priv = createPrivateKey(readFileSync(process.argv[2], 'utf8'));
const checks = [];
const check = (name, cond, info = '') => { checks.push(!!cond); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : `   <- ${typeof info === 'string' ? info : JSON.stringify(info)}`)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// workerd drops idle keep-alive sockets while the slow d1 execute calls run; retry once on a reset.
const fetch = async (url, opts) => { try { return await globalThis.fetch(url, opts); } catch (e) { if (e.cause?.code !== "ECONNRESET") throw e; await sleep(100); return globalThis.fetch(url, opts); } };

// mock Discord: record follow-up edits by interaction token
const edits = new Map();
const deletes = [];                 // interaction tokens whose reply was deleted
const privateReplies = new Map();   // token -> flags of an ephemeral follow-up
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const m = req.url.match(/^\/webhooks\/(\d+)\/([^/]+)\/messages\/@original$/);
    if (req.method === 'PATCH' && m) { edits.set(m[2], JSON.parse(body).content); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    if (req.method === 'DELETE' && m) { deletes.push(m[2]); res.writeHead(204); res.end(); return; }
    const f = req.url.match(/^\/webhooks\/(\d+)\/([^/?]+)$/);
    if (req.method === 'POST' && f) { const b = JSON.parse(body); privateReplies.set(f[2], b.flags); edits.set(f[2], b.content); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    if (req.method === 'GET' && req.url.startsWith('/cdn/')) { const seed = req.url.slice(5); res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from('PNGFAKE-' + seed)); return; }
    if (req.method === 'GET' && /^\/guilds\/\w+$/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ name: 'Mock Guild ' + req.url.split('/').pop() })); return; }
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
async function interact(payload, { badSig = false } = {}) {
  payload.token = payload.token || ('itok' + (++tokN));
  const body = JSON.stringify(payload); const ts = String(Math.floor(Date.now() / 1000));
  let sig = sign(null, Buffer.from(ts + body), priv).toString('hex');
  if (badSig) sig = (sig.startsWith('00') ? '11' : '00') + sig.slice(2);
  const r = await fetch(W + '/discord/interactions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body });
  let d; try { d = await r.json(); } catch { d = {}; }
  return [r.status, d, payload.token];
}
// run a command and return the follow-up text
async function run(name, options, who, guild = 'G1') {
  const [s, d, tok] = await interact({ type: 2, guild_id: guild, data: { name, options }, member: { nick: who.nick, user: { id: who.id, username: 'user' + who.id, global_name: 'Global' + who.id } } });
  for (let i = 0; i < 40 && !edits.has(tok); i++) await sleep(150);
  return { status: s, deferred: d.type === 5, ephemeral: !!(d.data?.flags & 64), text: edits.get(tok) || '', tok, private: privateReplies.get(tok) === 64 };
}

// --- accounts (guests, then give them Discord ids directly in the local DB)
const [, la] = await api('POST', '/auth/guest', { username: 'dc_leader' }); const leader = la.token;
const [, ma] = await api('POST', '/auth/guest', { username: 'dc_member' }); const member = ma.token;
const [, oa] = await api('POST', '/auth/guest', { username: 'dc_outsider' }); const outsider = oa.token;
const ids = {}; for (const [k, t] of [['leader', leader], ['member', member], ['outsider', outsider]]) { const [, me] = await api('GET', '/auth/me', null, t); ids[k] = me.id; }
const LEADER = { id: '111', nick: 'Boss Lady' }, MEMBER = { id: '222' }, OUTSIDER = { id: '333' };
execSync(`npx wrangler d1 execute guild-manager --local --command "UPDATE users SET discord_id='111', auth_type='discord' WHERE id='${ids.leader}'; UPDATE users SET discord_id='222', auth_type='discord' WHERE id='${ids.member}'; UPDATE users SET discord_id='333', auth_type='discord' WHERE id='${ids.outsider}'"`, { cwd: WORKER_DIR, stdio: 'ignore', shell: true });

const [, tc] = await api('POST', '/api/teams', { name: 'Bot Guild' }, leader); const team = tc.id || tc.team?.id;
const [, td] = await api('GET', `/api/teams/${team}`, null, leader); const code = (td.team || td).invite_code;
await api('POST', `/api/invite/${code}`, {}, member);
const [ps, pd] = await api('POST', `/api/teams/${team}/bosses/presets`, { presetId: 'lordnine', names: ['Venatus', 'Viorent', 'Roderick'] }, leader);
check('setup: 3 bosses added', ps === 200 && pd.added?.length === 3, pd);

// --- protocol
let [s, d] = await interact({ type: 1 });
check('PING -> PONG', s === 200 && d.type === 1, d);
[s, d] = await interact({ type: 1 }, { badSig: true });
check('bad signature -> 401', s === 401, [s, d]);
const r0 = await run('next', [], MEMBER);
check('/next before link: deferred, then says not linked', r0.deferred && /not linked/i.test(r0.text), r0);

// --- link
let r = await run('link', [{ name: 'code', value: 'NOPE1234' }], LEADER);
check('/link with a wrong code', r.ephemeral && /No team has that invite code/.test(r.text), r);
r = await run('link', [{ name: 'code', value: code }], MEMBER);
check('/link by a plain member refused', /Only the leader or an officer/.test(r.text), r);
r = await run('link', [{ name: 'code', value: code }], OUTSIDER);
check('/link by a non-member refused', /not a member/.test(r.text), r);
r = await run('link', [{ name: 'code', value: code }], LEADER);
check('/link by the leader works', /Linked this server to \*\*Bot Guild\*\*/.test(r.text), r);
let [, st] = await api('GET', `/api/teams/${team}/settings`, null, leader);
check('settings list the linked server', (st.discordGuilds || []).some(g => g.guildId === 'G1'), st.discordGuilds);

// --- next
r = await run('next', [], OUTSIDER);
check('/next works for anyone in the server', /Bot Guild/.test(r.text) && /Venatus/.test(r.text) && /Viorent/.test(r.text) && /Roderick/.test(r.text) && /Guild Manager/.test(r.text), r);
r = await run('next', [{ name: 'count', value: 1 }], OUTSIDER);
check('/next count=1 shows one boss', r.text.split('\n').filter(l => l.startsWith('`')).length === 1, r.text);   // one schedule row

// --- autocomplete
[s, d] = await interact({ type: 4, guild_id: 'G1', data: { name: 'killed', options: [{ name: 'boss', value: 'vio', focused: true }] }, member: { user: { id: '222', username: 'x' } } });
check('autocomplete filters bosses', s === 200 && d.type === 8 && d.data.choices.length === 1 && d.data.choices[0].name === 'Viorent', d);
[s, d] = await interact({ type: 4, guild_id: 'NOPE', data: { name: 'killed', options: [{ name: 'boss', value: 'v', focused: true }] }, member: { user: { id: '222', username: 'x' } } });
check('autocomplete on an unlinked server is empty', s === 200 && d.data.choices.length === 0, d);

// --- killed
r = await run('killed', [{ name: 'boss', value: 'Venatus' }], OUTSIDER);
check('/killed by a non-member refused', /Only members of/.test(r.text), r);
r = await run('killed', [{ name: 'boss', value: 'v' }], MEMBER);
check('/killed ambiguous name asks which one', /Which one\?/.test(r.text) && /Venatus/.test(r.text) && /Viorent/.test(r.text), r);
r = await run('killed', [{ name: 'boss', value: 'ven' }], MEMBER);
check('/killed by a member logs the kill', /☠️ \*\*Venatus\*\* killed by Global222/.test(r.text) && /Next spawn in 10h/.test(r.text), r);
let [, bl] = await api('GET', `/api/teams/${team}/bosses`, null, leader);
let ven = (bl.bosses || bl).find(b => b.name === 'Venatus');
check('Venatus timer reset to ~+10h with last_death set', Math.abs(ven.next_spawn - (Date.now() + 36000000)) < 120000 && ven.last_death > Date.now() - 120000, ven);
const [, choice] = await interact({ type: 4, guild_id: 'G1', data: { name: 'killed', options: [{ name: 'boss', value: 'vior', focused: true }] }, member: { user: { id: '222', username: 'x' } } });
r = await run('killed', [{ name: 'boss', value: choice.data.choices[0].value }, { name: 'minutes_ago', value: 30 }], LEADER);
check('/killed by boss id (autocomplete value) with minutes_ago', /\*\*Viorent\*\* killed by Boss Lady \(30 min ago\)/.test(r.text), r);
[, bl] = await api('GET', `/api/teams/${team}/bosses`, null, leader);
const vio = (bl.bosses || bl).find(b => b.name === 'Viorent');
check('Viorent next spawn = +10h minus 30 min', Math.abs(vio.next_spawn - (Date.now() + 36000000 - 1800000)) < 120000, vio);
{ const out = execSync(`npx wrangler d1 execute guild-manager --local --json --command "SELECT COUNT(*) AS n FROM boss_kill_log WHERE team_id='${team}' AND killed_by IS NOT NULL"`, { cwd: WORKER_DIR, shell: true }).toString();
  const n = JSON.parse(out.slice(out.indexOf('[')))[0].results[0].n;
  check('kill log has both kills attributed to members', n === 2, n); }

// --- unlink
r = await run('unlink', [], MEMBER);
check('/unlink by a plain member refused', /Only the leader or an officer/.test(r.text), r);
r = await run('unlink', [], LEADER);
check('/unlink by the leader works', /Unlinked/.test(r.text), r);
[, st] = await api('GET', `/api/teams/${team}/settings`, null, leader);
check('settings no longer list G1', !(st.discordGuilds || []).some(g => g.guildId === 'G1'), st.discordGuilds);
// link again, then unlink from Settings
await run('link', [{ name: 'code', value: code }], LEADER);
[s, d] = await api('PUT', `/api/teams/${team}/settings`, { unlinkDiscordGuild: 'G1' }, leader);
[, st] = await api('GET', `/api/teams/${team}/settings`, null, leader);
check('Settings PUT unlinkDiscordGuild removes that server', s === 200 && !(st.discordGuilds || []).some(g => g.guildId === 'G1'), [s, d, st.discordGuilds]);
// a team can hold several servers at once
await run('link', [{ name: 'code', value: code }], LEADER, 'G1');
await run('link', [{ name: 'code', value: code }], LEADER, 'G2');
[, st] = await api('GET', `/api/teams/${team}/settings`, null, leader);
check('two servers linked to one team', ['G1', 'G2'].every(g => (st.discordGuilds || []).some(x => x.guildId === g)), st.discordGuilds);
const rA = await run('next', [], OUTSIDER, 'G1'); const rB = await run('next', [], OUTSIDER, 'G2');
check('/next answers in both servers', /Bot Guild/.test(rA.text) && /Bot Guild/.test(rB.text), [rA.text.slice(0, 40), rB.text.slice(0, 40)]);
r = await run('unlink', [], LEADER, 'G2');
[, st] = await api('GET', `/api/teams/${team}/settings`, null, leader);
check('/unlink in G2 leaves G1 linked', /Unlinked/.test(r.text) && (st.discordGuilds || []).some(x => x.guildId === 'G1') && !(st.discordGuilds || []).some(x => x.guildId === 'G2'), st.discordGuilds);

// --- one-click link via the OAuth redirect
{
  const [ls, ld] = await api('GET', `/api/teams/${team}/discord-link`, null, member);
  check('discord-link URL refused for a plain member', ls === 403, [ls, ld]);
  const [s1, d1] = await api('GET', `/api/teams/${team}/discord-link`, null, leader);
  const u = new URL(d1.url || 'http://x');
  check('discord-link URL has client_id, bot+commands scopes, redirect and state', s1 === 200 && u.searchParams.get('client_id') === '1488742496660881528' && u.searchParams.get('scope') === 'applications.commands bot' && u.searchParams.get('redirect_uri').endsWith('/discord/added') && !!u.searchParams.get('state'), d1);
  const state = u.searchParams.get('state');
  const r1 = await fetch(`${W}/discord/added?guild_id=G9&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
  check('callback links the chosen server and redirects to the app', r1.status === 302 && /discord=linked/.test(r1.headers.get('location')), [r1.status, r1.headers.get('location')]);
  const [, st9] = await api('GET', `/api/teams/${team}/settings`, null, leader);
  check('settings list G9 after the callback', (st9.discordGuilds || []).some(g => g.guildId === 'G9'), st9.discordGuilds);
  const r2 = await fetch(`${W}/discord/added?guild_id=G10&state=${encodeURIComponent(state.slice(0, -4) + 'AAAA')}`, { redirect: 'manual' });
  check('callback with a tampered state redirects with error and changes nothing', r2.status === 302 && /discord=error/.test(r2.headers.get('location')), [r2.status, r2.headers.get('location')]);
  const [, st10] = await api('GET', `/api/teams/${team}/settings`, null, leader);
  check('G10 was not linked by the tampered state', !(st10.discordGuilds || []).some(g => g.guildId === 'G10'), st10.discordGuilds);
  const r3 = await fetch(`${W}/discord/added?error=access_denied&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
  check('callback after the user cancels redirects with cancelled', r3.status === 302 && /discord=cancelled/.test(r3.headers.get('location')), r3.headers.get('location'));
}

// --- rally attendance
{
  await run('link', [{ name: 'code', value: code }], LEADER, 'G1');
  await run('killed', [{ name: 'boss', value: 'Venatus' }], MEMBER, 'G1');
  const att = (id, seed, boss = 'Venatus') => ({ options: [{ name: 'boss', value: boss }, { name: 'proof', value: id }], resolved: { attachments: { [id]: { id, url: `http://127.0.0.1:8797/cdn/${seed}`, content_type: 'image/png', size: 1000, filename: 'p.png' } } } });
  async function runHere(who, data, guild = 'G1') {
    const [s, d, tok] = await interact({ type: 2, guild_id: guild, data: { name: 'here', ...data }, member: { user: { id: who.id, username: 'user' + who.id, global_name: 'Global' + who.id } } });
    for (let i = 0; i < 60 && !edits.has(tok); i++) await sleep(150);
    return { status: s, ephemeral: !!(d.data?.flags & 64), text: edits.get(tok) || '' };
  }
  let r = await runHere(OUTSIDER, att('a1', 'x1'));
  check('/here by a non-member refused', /Only members/.test(r.text), r);
  r = await runHere(MEMBER, att('a2', 'img-A'));
  check('/here with a screenshot -> pending, unflagged (kill logged today)', r.ephemeral && /pending an officer/.test(r.text) && !/flagged/.test(r.text), r);
  r = await runHere(MEMBER, att('a3', 'img-B'));
  check('second /here for the same boss today refused', /already checked in/.test(r.text), r);
  r = await runHere(LEADER, att('a4', 'img-A'));
  check('same screenshot by someone else is flagged as duplicate', /flagged:.*Same screenshot/.test(r.text), r);
  r = await runHere(MEMBER, att('a5', 'img-C', 'Roderick'));
  check('/here for a boss with no kill logged today is flagged', /No kill of Roderick logged today/.test(r.text), r);

  let [ls, ld] = await api('GET', `/api/teams/${team}/attendance?status=all`, null, leader);
  check('officer sees 3 claims, pending count 3', ls === 200 && ld.officer && ld.claims.length === 3 && ld.pending === 3, { n: ld.claims?.length, pending: ld.pending });
  const clean = ld.claims.find(c => c.username === 'dc_member' && c.bosses[0].name === 'Venatus');
  const dupClaim = ld.claims.find(c => c.username === 'dc_leader');
  check('claims carry flags and image availability', clean && clean.flags.length === 0 && clean.hasImage && dupClaim && dupClaim.flags.some(f => f.code === 'duplicate_image'), { clean: clean?.flags, dup: dupClaim?.flags });
  const imgRes = await fetch(`${W}/api/teams/${team}/attendance/${clean.id}/download?token=${encodeURIComponent(leader)}`);
  check('screenshot download returns the stored bytes', imgRes.status === 200 && (await imgRes.text()) === 'PNGFAKE-img-A', imgRes.status);
  [, ld] = await api('GET', `/api/teams/${team}/attendance`, null, member);
  check('a plain member sees only approved claims (none yet)', ld.officer === false && ld.claims.length === 0, ld);

  let [as, ad] = await api('POST', `/api/teams/${team}/attendance/approve-all`, {}, leader);
  check('approve-all approves the clean one and skips 2 flagged', as === 200 && ad.approved === 1 && ad.skippedFlagged === 2, ad);
  [as, ad] = await api('POST', `/api/teams/${team}/attendance/${dupClaim.id}/reject`, {}, leader);
  check('reject a flagged claim', as === 200, ad);
  [as, ad] = await api('POST', `/api/teams/${team}/attendance/${dupClaim.id}/approve`, {}, leader);
  check('cannot approve an already-rejected claim', as === 409, ad);
  [as, ad] = await api('POST', `/api/teams/${team}/attendance/${clean.id}/approve`, {}, member);
  check('plain member cannot approve', as === 403, ad);

  r = await run('rollcall', [{ name: 'boss', value: 'Venatus' }, { name: 'members', value: '<@222> <@333> <@999>' }], LEADER, 'G1');
  check('/rollcall logs team members only, skips the already-logged one, reports unknowns', /Roll call for \*\*Venatus\*\*/.test(r.text) && /already logged today: dc_member/.test(r.text) && /2 mentioned people are not on the team/.test(r.text), r);
  r = await run('rollcall', [{ name: 'boss', value: 'Viorent' }, { name: 'boss2', value: 'Roderick' }, { name: 'members', value: '<@111>' }], LEADER, 'G1');
  check('/rollcall with two bosses awards 2 points', /Roll call for \*\*Viorent \+ Roderick\*\*/.test(r.text) && /\(\+2 pts each\)/.test(r.text) && /: dc_leader/.test(r.text), r);
  r = await run('rollcall', [{ name: 'boss', value: 'Venatus' }, { name: 'members', value: '<@222>' }], MEMBER, 'G1');
  check('/rollcall by a plain member refused', /Only the leader or an officer/.test(r.text), r);

  const [, sum] = await api('GET', `/api/teams/${team}/attendance/summary?days=7`, null, leader);
  const me = sum.members.find(x => x.username === 'dc_member'); const ld2 = sum.members.find(x => x.username === 'dc_leader');
  check('summary: dc_member 1 rally / 1 pt, dc_leader 1 rally / 2 pts', me && me.rallies === 1 && me.points === 1 && ld2 && ld2.rallies === 1 && ld2.points === 2, sum.members);
  const [, ledger] = await api('GET', `/api/teams/${team}/dkp`, null, leader);
  const bal = (n) => (ledger.balances || []).find(x => x.username === n)?.balance;
  check('points landed in the ledger balances', bal('dc_member') === 1 && bal('dc_leader') === 2, ledger.balances);

  await api('PUT', `/api/teams/${team}/settings`, { attendanceAutoApprove: true, attendancePoints: 2 }, leader);
  await run('killed', [{ name: 'boss', value: 'Viorent' }], MEMBER, 'G1');
  r = await runHere(MEMBER, att('a7', 'img-E', 'Viorent'));
  check('trust mode approves an unflagged /here on arrival with the configured points', /approved, \+2 pts/.test(r.text), r);
  await api('PUT', `/api/teams/${team}/settings`, { attendanceSelfCheckin: false }, leader);
  r = await runHere(MEMBER, att('a8', 'img-F', 'Viorent'));
  check('self check-in off -> /here refused', /roll call only/.test(r.text), r);
}

// --- auto-delete of replies + private errors (lib/discord-cleanup.js)
{
  const sqlJson = (q) => { const out = execSync(`npx wrangler d1 execute guild-manager --local --json --command "${q}"`, { cwd: WORKER_DIR, shell: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); return JSON.parse(out.slice(out.indexOf('[')))[0].results; };
  const queued = (tok) => sqlJson(`SELECT delete_at FROM discord_cleanup WHERE token='${tok}'`)[0]?.delete_at;
  await api('PUT', `/api/teams/${team}/settings`, { discordAutoDelete: true, discordDeleteActionMin: 1, discordDeleteNextMin: 5 }, leader);
  let t0 = Date.now();
  let e = await run('killed', [{ name: 'boss', value: 'Nosuchboss' }], MEMBER, 'G1');
  await sleep(300);
  check('error in a public command: shown only to the invoker, public placeholder deleted', e.private && /No boss called/.test(e.text) && deletes.includes(e.tok) && !queued(e.tok), e);
  e = await run('killed', [{ name: 'boss', value: 'Venatus' }], MEMBER, 'G1'); await sleep(300);
  const qa = queued(e.tok);
  check('/killed reply queued for deletion ~1 min later', /killed by/.test(e.text) && !e.private && qa && Math.abs(qa - (t0 + 60000)) < 15000, [e.text, qa && qa - t0]);
  t0 = Date.now();
  const nx = await run('next', [], OUTSIDER, 'G1'); await sleep(300);
  const qn = queued(nx.tok);
  check('/next reply queued ~5 min later', qn && Math.abs(qn - (t0 + 300000)) < 15000, qn && qn - t0);
  execSync(`npx wrangler d1 execute guild-manager --local --command "UPDATE discord_cleanup SET delete_at = 1 WHERE token='${e.tok}'"`, { cwd: WORKER_DIR, shell: true, stdio: 'ignore' });
  await fetch(W + '/__scheduled?cron=*+*+*+*+*'); await sleep(500);
  check('cron deletes the due reply and drops the row, leaves the /next one', deletes.includes(e.tok) && !queued(e.tok) && !deletes.includes(nx.tok) && queued(nx.tok), [deletes.slice(-3), queued(nx.tok)]);
  await api('PUT', `/api/teams/${team}/settings`, { discordAutoDelete: false }, leader);
  const [, stg] = await api('GET', `/api/teams/${team}/settings`, null, leader);
  const off = await run('next', [], OUTSIDER, 'G1'); await sleep(300);
  check('auto-delete off: nothing queued; settings report it', stg.discordAutoDelete === false && stg.discordDeleteNextMin === 5 && !queued(off.tok), [stg.discordAutoDelete, queued(off.tok)]);
  await api('PUT', `/api/teams/${team}/settings`, { discordAutoDelete: true, discordDeleteNextMin: 99 }, leader);
  const [, stg2] = await api('GET', `/api/teams/${team}/settings`, null, leader);
  check('delay clamps to 14 min (interaction tokens live 15)', stg2.discordDeleteNextMin === 14, stg2.discordDeleteNextMin);
}

mock.close();
const n = checks.filter(Boolean).length; console.log(`\n${n}/${checks.length} checks passed`); process.exit(n === checks.length ? 0 : 1);
