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

// 1. an ordinary day is untouched
const small = [...rowsOf(10, 'reset', 60, 20, 'Old'), ...rowsOf(10, 'waiting', 900, 20, 'New')];
const smallText = fitScheduleText(small, tz);
check('short day: same text as before, no notes', smallText === scheduleLines(small, tz).join('\n') && !smallText.includes('…'));

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
check('top line counts the finished spawns that were cut', /^\*… \d+ earlier spawns finished\*$/.test(lines[0]), lines[0]);
check('oldest finished cut, newest finished kept', !busyText.includes('Old Boss 1 |') && busyText.includes('Old Boss 60 |'));
check('every boss up now kept', up.every(r => busyText.includes(r.name + ' |')));
check('every upcoming spawn kept (finished lines were enough)', later.every(r => busyText.includes(r.name + ' |')) && !busyText.includes('coming later'));
const cut = Number(lines[0].match(/\d+/)[0]);
const keptOld = finished.filter(r => busyText.includes(r.name + ' |')).length;
check('cut count + kept lines = all finished spawns', cut + keptOld === finished.length, { cut, keptOld });
const oneFewer = [`*… ${cut - 1} earlier spawns finished*`, ...scheduleLines(busy.filter(r => !finished.slice(0, cut - 1).includes(r)), tz)].join('\n');
check('trims no more than needed (keeping one more finished line would not fit)', oneFewer.length > EMBED_TEXT_MAX, oneFewer.length);

// 3. even with every finished line gone, too many still to come: cut from the far end
const many = [...rowsOf(5, 'dead', 10, 5, 'Old'), ...rowsOf(2, 'window', 60, 1, 'Up'), ...rowsOf(90, 'waiting', 90, 9, 'New')];
const manyText = fitScheduleText(many, tz);
const manyLines = manyText.split('\n');
check('huge day still fits', manyText.length <= EMBED_TEXT_MAX, manyText.length);
check('all 5 finished cut and counted', manyLines[0] === '*… 5 earlier spawns finished*' && !manyText.includes('Old Boss'), manyLines[0]);
check('bottom line counts spawns still to come', /^\*… \d+ more coming later today\*$/.test(manyLines.at(-1)), manyLines.at(-1));
check('bosses in their window kept', manyText.includes('Up Boss 1 |') && manyText.includes('Up Boss 2 |'));
check('soonest upcoming kept, latest cut', manyText.includes('New Boss 1 |') && !manyText.includes('New Boss 90 |'));
const later2 = Number(manyLines.at(-1).match(/\d+/)[0]);
const keptNew = many.filter(r => r.state === 'waiting' && manyText.includes(r.name + ' |')).length;
check('cut count + kept lines = all upcoming spawns', later2 + keptNew === 90, { later2, keptNew });

// 4. singular wording
const one = fitScheduleText([...rowsOf(1, 'dead', 10, 5, 'Old'), ...rowsOf(1, 'waiting', 90, 9, 'New')], tz, 60);
check('"1 earlier spawn finished" (singular)', one.startsWith('*… 1 earlier spawn finished*'), one);

console.log(`\n${pass}/${pass + fail} checks passed`);
