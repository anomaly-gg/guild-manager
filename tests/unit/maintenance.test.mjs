// Maintenance reset planning, no server (worker/src/lib/maintenance.js planReset): which bosses go up
// at server open for a maintenance window, and which are left alone.
import { planReset } from '../../worker/src/lib/maintenance.js';

let pass = 0, fail = 0;
const check = (n, c, i = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '   <- ' + JSON.stringify(i))); };

const H = 3600000, from = 9 * H, openAt = 14 * H;   // maintenance 09:00 - 14:00
const boss = (id, type, next_spawn, last_death = null) => ({ id, name: id, type, next_spawn, last_death });
const bosses = [
  boss('venatus', 'interval', 20 * H),                 // respawn timer: always up at open
  boss('killedLate', 'interval', 30 * H, 14.2 * H),    // killed after the server opened: reset pressed late
  boss('dueInside', 'fixed', 10 * H),                  // fixed boss due 10:00, still waiting (reset set up in advance)
  boss('upInside', 'weekly', 11 * H),                  // fixed boss shown up since 11:00, nobody could kill it
  boss('autoReset', 'biweekly', 170 * H),              // due 12:00, we auto-reset it to next week during maintenance
  boss('outside', 'fixed', 20 * H),                    // due after the server opens: keeps its time
  boss('before', 'fixed', 8 * H + 30 * 60000),         // due 08:30, before maintenance: keeps its time
  boss('atOpen', 'twicedaily', 14 * H),                // due exactly at open: its own spawn, keeps its time
];
const resets = [
  { id: 'r1', boss_id: 'autoReset', spawn_at: 12 * H },
  { id: 'r2', boss_id: 'venatus', spawn_at: 13 * H },  // a respawn timer we auto-reset while the server was down
  { id: 'r3', boss_id: 'killedLate', spawn_at: 9.5 * H },
];
const p = planReset(bosses, resets, { from, openAt });
const ids = (list) => list.map(b => b.id).sort().join();

check('respawn timers up at open', ids(p.up) === 'venatus', ids(p.up));
check('fixed bosses due inside the window: waiting, shown up, or already auto-reset', ids(p.fixed) === 'autoReset,dueInside,upInside', ids(p.fixed));
check('fixed bosses outside the window keep their times (before, after, exactly at open)', ids(p.kept) === 'atOpen,before,outside', ids(p.kept));
check('a boss killed after the server opened is left alone', ids(p.killed) === 'killedLate', ids(p.killed));
check('auto-resets during maintenance of bosses brought up are dropped, the left-alone one kept', p.resetRows.sort().join() === 'r1,r2', p.resetRows);

const logged = planReset([boss('autoReset', 'fixed', 170 * H, 12.5 * H)], [{ id: 'r1', boss_id: 'autoReset', spawn_at: 12 * H }], { from, openAt });
check('a kill logged inside the window wins over the auto-reset', ids(logged.kept) === 'autoReset' && !logged.resetRows.length, logged);

const old = planReset(bosses, resets, { from: null, openAt });
check('no window (older dialog): respawn timers only', ids(old.up) === 'venatus' && !old.fixed.length && ids(old.kept) === 'atOpen,autoReset,before,dueInside,outside,upInside' && !old.resetRows.length, old);

console.log(`\n${pass}/${pass + fail} checks passed`);
