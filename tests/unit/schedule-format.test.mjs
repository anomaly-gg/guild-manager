// Daily schedule post text (worker/src/lib/schedule-format.js): a day too long for one Discord embed
// (every boss respawning after maintenance) must shed the oldest finished lines first, then the latest
// upcoming ones, and never the bosses up right now. No server needed.
import { fitScheduleText, scheduleLines, EMBED_TEXT_MAX } from '../../worker/src/lib/schedule-format.js';

let pass = 0, fail = 0;
const check = (n, c, i = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '   <- ' + JSON.stringify(i))); };

const tz = 'Asia/Manila';
const day0 = Date.parse('2026-09-29T00:00:00+08:00');
const TAG = '<@&123456789012345678>';   // a real-length role mention
// n rows from `start`, `step` minutes apart, all in one state
const rowsOf = (n, state, start, step, prefix) => Array.from({ length: n }, (_, i) => ({
  at: day0 + (start + i * step) * 60000, name: `${prefix} Boss ${i + 1}`, location: 'Ruins of Eldar', tag: TAG, state,
}));

// A row's line is in the text (finished lines read "Name · …", live ones "**Name** · …"; the " ·"
// keeps "Boss 1" from matching "Boss 10").
const has = (text, r) => text.includes(r.name + ' ·') || text.includes(r.name + '** ·');
// Display order: finished spawns first, then the rest, each in time order.
const isDone = (r) => r.state === 'dead' || r.state === 'reset';
const order = (rows) => [...rows.filter(isDone), ...rows.filter(r => !isDone(r))];

// 1. an ordinary day is untouched
const small = [...rowsOf(10, 'reset', 60, 20, 'Old'), ...rowsOf(10, 'waiting', 900, 20, 'New')];
const smallText = fitScheduleText(small, tz);
check('short day: every line kept, no notes', small.every(r => has(smallText, r)) && !smallText.includes('…'));
check('short day: summary line on top, zero counts left out', smallText.startsWith('-# ✅ 10 done  ·  ⏳ 10 to go\n\n'), smallText.split('\n')[0]);

// 2. after maintenance: lots finished, a few up, the rest still to come
const finished = rowsOf(60, 'reset', 30, 8, 'Old');
const up = rowsOf(3, 'spawned', 520, 1, 'Up');
const later = rowsOf(20, 'waiting', 600, 30, 'New');
const busy = [...finished, ...up, ...later].sort((a, b) => a.at - b.at);
const full = scheduleLines(busy, tz).join('\n');
const busyText = fitScheduleText(busy, tz);
const lines = busyText.split('\n');
console.log(`   post-maintenance day: ${full.length} chars untrimmed -> ${busyText.length}`);
check('busy day really is over the limit untrimmed', full.length > EMBED_TEXT_MAX);
check('trimmed to fit an embed', busyText.length <= EMBED_TEXT_MAX);
check('summary counts the whole day, cut lines included', lines[0] === '-# ✅ 60 done  ·  🔴 3 up  ·  ⏳ 20 to go', lines[0]);
check('line under the summary counts the finished spawns that were cut', /^-# … \d+ earlier spawns finished$/.test(lines[2]), lines[2]);
check('oldest finished cut, newest finished kept', !has(busyText, finished[0]) && has(busyText, finished.at(-1)));
check('every boss up now kept', up.every(r => has(busyText, r)));
check('every upcoming spawn kept (finished lines were enough)', later.every(r => has(busyText, r)) && !busyText.includes('coming later'));
const cut = Number(lines[2].match(/\d+/)[0]);
const keptOld = finished.filter(r => has(busyText, r)).length;
check('cut count + kept lines = all finished spawns', cut + keptOld === finished.length, { cut, keptOld });
const oneFewer = [lines[0], '', `-# … ${cut - 1} earlier spawns finished`, ...scheduleLines(order(busy.filter(r => !finished.slice(0, cut - 1).includes(r))), tz)].join('\n');
check('trims no more than needed (keeping one more finished line would not fit)', oneFewer.length > EMBED_TEXT_MAX, oneFewer.length);

// 3. even with every finished line gone, too many still to come: cut from the far end
const many = [...rowsOf(5, 'dead', 10, 5, 'Old'), ...rowsOf(2, 'window', 60, 1, 'Up'), ...rowsOf(90, 'waiting', 90, 9, 'New')];
const manyText = fitScheduleText(many, tz);
const manyLines = manyText.split('\n');
check('huge day still fits', manyText.length <= EMBED_TEXT_MAX, manyText.length);
check('all 5 finished cut and counted', manyLines[2] === '-# … 5 earlier spawns finished' && !manyText.includes('Old Boss'), manyLines[2]);
check('bottom line counts spawns still to come', /^-# … \d+ more coming later today$/.test(manyLines.at(-1)), manyLines.at(-1));
check('bosses in their window kept', has(manyText, many[5]) && has(manyText, many[6]));
check('soonest upcoming kept, latest cut', has(manyText, many[7]) && !has(manyText, many.at(-1)));
const later2 = Number(manyLines.at(-1).match(/\d+/)[0]);
const keptNew = many.filter(r => r.state === 'waiting' && has(manyText, r)).length;
check('cut count + kept lines = all upcoming spawns', later2 + keptNew === 90, { later2, keptNew });

// 4. singular wording
const one = fitScheduleText([...rowsOf(1, 'dead', 10, 5, 'Old'), ...rowsOf(1, 'waiting', 90, 9, 'New')], tz, 60);
check('"1 earlier spawn finished" (singular)', one.split('\n')[2] === '-# … 1 earlier spawn finished', one);

// 5. the look of each line
const at = (min) => day0 + min * 60000;
const sec = (min) => Math.floor(at(min) / 1000);
const look = fitScheduleText([
  { at: at(124), name: 'Lady Dalia', group: 'Kongreso', state: 'dead' },
  { at: at(813), name: 'Wannitas', group: 'Kongreso', state: 'reset' },
  { at: at(815), name: 'Metus', state: 'dead' },
  { at: at(905), name: 'Baron Braudmore', tag: TAG, state: 'spawned' },
  { at: at(912), name: 'Gareth', location: 'Ruins of Eldar', tag: TAG, state: 'window', windowEnd: at(938) },
  { at: at(1140), name: 'Neutro', tag: TAG, state: 'waiting', next: true },
  { at: at(1204), name: 'Catena', state: 'waiting' },
], tz).split('\n');
check('finished: small grey, crossed out, plain group name, ✓', look.some(l => /^-# ~~`2:04.AM.` Lady Dalia · Kongreso~~ ✓$/u.test(l)), look);
check('auto-reset: ↺ auto-reset', look.some(l => /^-# ~~`[^`]+` Wannitas · Kongreso~~ ↺ auto-reset$/.test(l)), look);
check('finished with no group: no trailing separator', look.some(l => /^-# ~~`[^`]+` Metus~~ ✓$/.test(l)), look);
check('finished lines packed together, no blank lines between them', look.slice(2, 5).every(l => l.startsWith('-# ~~')), look);
check('up: bold name, role, 🔴 up + live timestamp of the spawn', look.some(l => l.endsWith(`\` **Baron Braudmore** ${TAG} 🔴 up <t:${sec(905)}:R>`)), look);
check('window: location after the name, closes at window end', look.some(l => l.endsWith(`\` **Gareth** · Ruins of Eldar ${TAG} 🟠 window closes <t:${sec(938)}:R>`)), look);
check('next: ⏳ countdown on the soonest spawn only', look.some(l => l.endsWith(`\` **Neutro** ${TAG} ⏳ next, <t:${sec(1140)}:R>`)) && look.filter(l => l.includes('⏳ next')).length === 1, look);
check('plain upcoming line: time + bold name, nothing after', look.some(l => /^`[^`]+` \*\*Catena\*\*$/.test(l)), look);
check('blocks split by a blank line, never a dashed divider', look.includes('') && !look.some(l => /^-{5,}$/.test(l)), look);

console.log(`\n${pass}/${pass + fail} checks passed`);
