// Guild Manager test runner:  node tests/run_all.mjs [suite ...]
//
// Runs every suite against a LOCAL worker (`wrangler dev --local`) with a fresh local D1 per group
// (the Discord suites give users fixed Discord ids, which must be unique). Never touches the live
// database. Test settings are passed with --var, so .dev.vars is not needed; the Discord signing key
// is generated per run (its public half goes to the worker), so no private key lives in the repo.
// Ports: worker 8788, site harness 8790, mock Discord 8797 (inside the suites), mock Gumroad 8799.
// Logs: tests/.out/<suite>.log. Exit code 0 = everything passed.

import { spawn, execSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TESTS, '..');
const WORKER = join(ROOT, 'worker');
const OUT = join(TESTS, '.out');
const WIN = process.platform === 'win32';
const PY = WIN ? 'python' : 'python3';

// suite -> how to run it; `db` = which fresh-database group it shares
const SUITES = [
  { name: 'schedule-parse', db: null, cmd: ['node', join(TESTS, 'unit/schedule-parse.test.mjs')] },
  { name: 'billing', db: 'api', gumroad: true, cmd: [PY, join(TESTS, 'api/billing.test.py'), WORKER] },
  { name: 'presets', db: 'api', cmd: [PY, join(TESTS, 'api/presets.test.py')] },
  { name: 'account', db: 'api', cmd: [PY, join(TESTS, 'api/account.test.py')] },
  { name: 'discord', db: 'discord', cmd: ['node', join(TESTS, 'api/discord.test.mjs'), '{key}', WORKER] },
  { name: 'schedule', db: 'schedule', cmd: ['node', join(TESTS, 'api/schedule.test.mjs'), '{key}', WORKER] },
  { name: 'import-e2e', db: 'browser', site: true, cmd: [PY, join(TESTS, 'browser/import.e2e.py'), WORKER] },
  { name: 'boss-edit-e2e', db: 'browser', site: true, cmd: [PY, join(TESTS, 'browser/boss-edit.e2e.py'), WORKER] },
];

const wanted = process.argv.slice(2);
const suites = wanted.length ? SUITES.filter(s => wanted.includes(s.name)) : SUITES;
if (!suites.length) { console.log('Suites:', SUITES.map(s => s.name).join(', ')); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const portFree = (port) => new Promise(ok => { const s = createServer(); s.once('error', () => ok(false)); s.listen(port, '127.0.0.1', () => s.close(() => ok(true))); });

function start(cmd, args, opts = {}) {
  const o = { cwd: opts.cwd || ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: !WIN, env: { ...process.env, ...opts.env } };
  // npx is a .cmd on Windows, which needs a shell; hand it one quoted string (no args array + shell).
  const p = WIN && cmd === 'npx' ? spawn('npx ' + args.map(a => `"${a}"`).join(' '), { ...o, shell: true }) : spawn(cmd, args, o);
  p.log = '';
  p.stdout.on('data', d => { p.log += d; });
  p.stderr.on('data', d => { p.log += d; });
  return p;
}
function stop(p) {
  if (!p || p.exitCode !== null) return;
  try { WIN ? execSync(`taskkill /PID ${p.pid} /T /F`, { stdio: 'ignore' }) : process.kill(-p.pid, 'SIGKILL'); } catch { /* already gone */ }
}
async function waitHttp(url, ms = 90000) {
  for (let t = 0; t < ms; t += 500) { try { await fetch(url); return true; } catch { await sleep(500); } }
  return false;
}

// ---- Discord signing key for this run
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
mkdirSync(OUT, { recursive: true });
const keyPath = join(OUT, 'discord_test_key.pem');
writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));

const VARS = {
  JWT_SECRET: 'local-test-secret', DISCORD_CLIENT_ID: 'test', DISCORD_BOT_TOKEN: 'test',
  DISCORD_APP_ID: '1488742496660881528', DISCORD_PUBLIC_KEY: pubHex, DISCORD_API: 'http://127.0.0.1:8797',
  GUMROAD_API: 'http://127.0.0.1:8799',
  GUMROAD_MONTHLY_URL: 'https://example.gumroad.com/l/gm-monthly', GUMROAD_LIFETIME_URL: 'https://example.gumroad.com/l/gm-lifetime',
  GUMROAD_MONTHLY_PRODUCT_ID: 'vbeeit', GUMROAD_LIFETIME_PRODUCT_ID: 'gm-lifetime',
};

let worker = null, site = null, gumroad = null;
async function freshWorker() {
  stop(worker); stop(site); site = null;
  await sleep(1000);
  rmSync(join(WORKER, '.wrangler', 'state', 'v3', 'd1'), { recursive: true, force: true });   // local test DB only
  const args = ['wrangler', 'dev', '--local', '--port', '8788', '--test-scheduled', ...Object.entries(VARS).flatMap(([k, v]) => ['--var', `${k}:${v}`])];
  worker = start('npx', args, { cwd: WORKER });
  if (!(await waitHttp('http://127.0.0.1:8788/'))) throw new Error('local worker did not start:\n' + worker.log.slice(-2000));
}

// ---- refuse to fight a dev server that is already running
for (const port of [8788, 8790, 8797, 8799]) {
  if (!(await portFree(port))) { console.error(`Port ${port} is in use (a dev server or an earlier test run?). Stop it and run again.`); process.exit(1); }
}

const results = [];
let group;
try {
  for (const s of suites) {
    if (s.db && s.db !== group) { process.stdout.write(`-- fresh local database (${s.db})\n`); await freshWorker(); group = s.db; }
    if (s.site && !site) { site = start(PY, [join(TESTS, 'lib/local_site.py')]); await waitHttp('http://127.0.0.1:8790/'); }
    if (s.gumroad && !gumroad) { gumroad = start(PY, [join(TESTS, 'lib/mock_gumroad.py'), '8799']); await sleep(800); }
    const t0 = Date.now();
    const p = start(s.cmd[0], s.cmd.slice(1).map(a => a === '{key}' ? keyPath : a), { env: { OUT, PYTHONIOENCODING: 'utf-8' } });
    const code = await new Promise(r => p.on('close', r));
    writeFileSync(join(OUT, `${s.name}.log`), p.log);
    const m = [...p.log.matchAll(/(\d+)\/(\d+) checks passed/g)].pop();
    const ok = m && m[1] === m[2] && !/^FAIL /m.test(p.log);
    results.push({ name: s.name, ok, tally: m ? `${m[1]}/${m[2]}` : `no result (exit ${code})` });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(15)} ${results.at(-1).tally.padEnd(8)} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (!ok) for (const line of p.log.split('\n').filter(l => /^FAIL |Error|Traceback/.test(l)).slice(0, 8)) console.log('      ' + line.slice(0, 300));
  }
} finally {
  stop(site); stop(gumroad); stop(worker);
  if (existsSync(keyPath)) rmSync(keyPath);
}
const failed = results.filter(r => !r.ok);
console.log(failed.length ? `\n${failed.length} suite(s) failed: ${failed.map(r => r.name).join(', ')} (logs in tests/.out/)` : `\nAll ${results.length} suites passed.`);
process.exitCode = failed.length ? 1 : 0;
