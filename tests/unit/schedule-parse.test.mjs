// Screenshot import parser + planner (js/modules/schedule-parse.js), fed the text Tesseract read
// from a real Discord schedule post (note the misread "lcaruthia"). No server needed.
import { parseScheduleText, buildPlan, matchName, zonedToEpoch, laterGroupsFor } from '../../js/modules/schedule-parse.js';
import { LORD_NINE } from '../../worker/src/presets/lordnine.js';

const OCR = `29 September 2026

2:04 AM | Lady Dalia (85)| @Kongreso
11:30 AM | Saphirus (80) | @Senado
1:30 PM | Araneo (75) | @Kongreso
1:32 PM | Livera (75) | @Kongreso

1:33 PM | Wannitas (93) | @Kongreso
1:35 PM | Metus (93) | @Kongreso

1:37 PM | Duplican (93) | @Kongreso
1:45 PM | Undomiel (80) | @kongreso
2:39 PM |Titore (98) | @Senado

3:05 PM | Baron Braudmore (88) | @Senado
3:12 PM | Gareth (98) | @Senado

7:00 PM | Neutro (80) | @Senado

8:04 PM | Lady Dalia (85) | @Senado
9:00 PM _|lcaruthia (135) | IMPORTANT
10:00 PM | Rakajeth (130)

11:54 PM | Catena (100) | @Kongreso
11:57 PM | Shuliar (95) | @Kongreso

30 September 2026

12:00 AM | Larba (98) | @Kongreso ae
`;
let pass = 0, fail = 0;
const check = (n, c, i = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '   <- ' + JSON.stringify(i))); };
const tz = 'Asia/Manila';

const rows = parseScheduleText(OCR);
check('18 rows parsed (every line of the screenshot)', rows.length === 18, rows.length);
check('row 1: 2:04 AM Lady Dalia lvl 85 @Kongreso on 29 Sep', rows[0].h === 2 && rows[0].min === 4 && rows[0].name === 'Lady Dalia' && rows[0].level === 85 && rows[0].tag === 'Kongreso' && rows[0].date.d === 29 && rows[0].date.m === 8);
check('PM conversion + noisy pipe: 9:00 PM lcaruthia', rows.find(r => r.name === 'lcaruthia')?.h === 21);
check('12:00 AM on 30 Sep = hour 0, next day', rows[17].h === 0 && rows[17].date.d === 30 && rows[17].tag === 'Kongreso');
check('no tag on Rakajeth; IMPORTANT is not a tag', rows.find(r => r.name === 'Rakajeth').tag === undefined && rows.find(r => r.name === 'lcaruthia').tag === undefined);
check('matchName: lcaruthia -> Icaruthia (OCR fold)', matchName('lcaruthia', [{ name: 'Icaruthia' }, { name: 'Catena' }])?.item.name === 'Icaruthia');
check('matchName: no false match for unrelated names', matchName('Rakajeth', [{ name: 'Catena' }, { name: 'Larba' }]) === null);
check('zonedToEpoch: 29 Sep 2026 2:04 AM Manila = 28 Sep 18:04 UTC', zonedToEpoch(2026, 8, 29, 2, 4, tz) === Date.UTC(2026, 8, 28, 18, 4));

// plan at 29 Sep 12:00 PM Manila
const now = zonedToEpoch(2026, 8, 29, 12, 0, tz);
const bosses = [{ id: 'b1', name: 'Lady Dalia' }, { id: 'b2', name: 'Araneo' }, { id: 'b3', name: 'Icaruthia' }, { id: 'b4', name: 'livera' }];
const groups = [{ id: 'g1', name: 'Kongreso' }, { id: 'g2', name: 'Senado' }];
const plan = buildPlan(rows, { bosses, presets: LORD_NINE.bosses, groups, tz, now });
const by = (n) => plan.filter(p => p.row.name === n);
check('Lady Dalia 2:04 AM is past -> skip', by('Lady Dalia')[0].action === 'skip' && by('Lady Dalia')[0].reason === 'already past');
check('Lady Dalia 8:04 PM -> update b1 with @Senado', by('Lady Dalia')[1].action === 'update' && by('Lady Dalia')[1].boss.id === 'b1' && by('Lady Dalia')[1].group?.id === 'g2');
// at 1:00 AM both Lady Dalia lines are upcoming: the first sets the timer, the second is its later spawn
const early = buildPlan(rows, { bosses, presets: LORD_NINE.bosses, groups, tz, now: zonedToEpoch(2026, 8, 29, 1, 0, tz) });
const ld = early.filter(p => p.row.name === 'Lady Dalia');
check('two upcoming Lady Dalia lines: first = update @Kongreso, second = later @Senado', ld[0].action === 'update' && ld[0].group?.id === 'g1' && ld[1].action === 'later' && ld[1].checked && ld[1].group?.id === 'g2', ld.map(p => [p.action, p.group?.id]));
check('laterGroupsFor hands Senado to the 2nd spawn', JSON.stringify(laterGroupsFor(early, ld[0])) === '["g2"]', laterGroupsFor(early, ld[0]));
check('Saphirus 11:30 AM (30 min ago, beyond grace) -> skip past', by('Saphirus')[0].action === 'skip');
check('Araneo -> update existing', by('Araneo')[0].action === 'update' && by('Araneo')[0].boss.id === 'b2');
check('Livera matches "livera" regardless of case', by('Livera')[0].boss?.id === 'b4');
check('lcaruthia -> update Icaruthia (fuzzy flagged)', by('lcaruthia')[0].boss?.id === 'b3' && by('lcaruthia')[0].fuzzy);
const unknownPreset = plan.filter(p => p.action === 'add' && !p.preset).map(p => p.row.name);
const fromPreset = plan.filter(p => p.action === 'add' && p.preset).map(p => p.row.name);
console.log('   add from preset:', fromPreset.join(', '));
console.log('   add, needs respawn rule:', unknownPreset.join(', ') || '(none)');
check('new bosses resolve from the Lord Nine preset where it has them', fromPreset.includes('Gareth') && fromPreset.includes('Catena'));
check('Larba (30 Sep 12:00 AM) -> add, tomorrow', by('Larba')[0].action === 'add' && by('Larba')[0].at === zonedToEpoch(2026, 8, 30, 0, 0, tz));
check('undated line: next occurrence', (() => { const [r] = parseScheduleText('1:00 PM | Venatus'); const p = buildPlan([r], { bosses: [], presets: LORD_NINE.bosses, groups, tz, now }); return p[0].at === zonedToEpoch(2026, 8, 29, 13, 0, tz); })());
check('undated line already past -> tomorrow', (() => { const [r] = parseScheduleText('9:00 AM | Venatus'); const p = buildPlan([r], { bosses: [], presets: LORD_NINE.bosses, groups, tz, now }); return p[0].at === zonedToEpoch(2026, 8, 30, 9, 0, tz) && p[0].action === 'add'; })());
const misread = parseScheduleText('4:17 an | Lady Dalia (85) | @Kongreso\n4:32 An || Araneo (75) | @Kongreso\n10:17 pm | Gareth\n9:05 p.m. | Titore\n11:30 arn | Metus');
check('OCR misreads of AM/PM ("an", "An", "p.m.", "arn") and doubled pipes', misread.length === 5 && misread[0].h === 4 && misread[0].name === 'Lady Dalia'
  && misread[1].name === 'Araneo' && misread[1].tag === 'Kongreso' && misread[2].h === 22 && misread[3].h === 21 && misread[4].h === 11 && misread[4].name === 'Metus', misread);
check('unknown @tag flagged, not guessed', (() => { const [r] = parseScheduleText('1:00 PM | Venatus | @Pugs'); const p = buildPlan([r], { bosses: [], presets: [], groups, tz, now }); return p[0].groupUnknown && !p[0].group; })());
console.log(`\n${pass}/${pass + fail} checks passed`);
