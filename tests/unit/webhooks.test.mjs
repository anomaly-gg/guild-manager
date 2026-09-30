// Discord channel lists, no server (worker/src/lib/webhooks.js): the stored format, values saved
// before channels became lists, the main-channel fallback, and message ids per channel.
import { parseHooks, hookUrls, storeHooks, publicHooks, alertHooks, parseMsgs, storeMsgs, keepMsgs, hookId } from '../../worker/src/lib/webhooks.js';

let pass = 0, fail = 0;
const check = (n, c, i = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '   <- ' + JSON.stringify(i))); };

const A = 'https://discord.com/api/webhooks/111/tokA', B = 'https://discord.com/api/webhooks/222/tokB', C = 'https://discordapp.com/api/webhooks/333/tok_C-3';

// ---- channel lists
check('hook id is the number in the URL', hookId(A) === '111' && hookId(C) === '333');
check('empty column: no channels', parseHooks(null).length === 0 && parseHooks('').length === 0);
check('a bare URL saved before lists is a one-channel list', JSON.stringify(parseHooks(A)) === JSON.stringify([{ u: A, n: null }]));
const stored = storeHooks([{ u: A, n: 'Alerts' }, { u: B }]);
check('stored as JSON, read back in order with names', hookUrls(stored).join() === [A, B].join() && parseHooks(stored)[0].n === 'Alerts' && parseHooks(stored)[1].n === null, stored);
check('empty list stores NULL', storeHooks([]) === null);
check('invalid entries are dropped, never sent to', hookUrls(JSON.stringify([{ u: 'https://evil.example/x' }, { u: A }, null, { n: 'x' }])).join() === A);
check('broken JSON reads as no channels', parseHooks('[{').length === 0);
const pub = publicHooks(stored);
check('Settings get id + name, never the token', pub[0].id === '111' && pub[0].name === 'Alerts' && !JSON.stringify(pub).includes('tok'), pub);

// ---- boss / event alerts fall back to the main channels
check('own channels win', alertHooks({ webhook_url: A, webhook_boss: storeHooks([{ u: B }, { u: C }]) }, 'boss').join() === [B, C].join());
check('no own channels: the main ones', alertHooks({ webhook_url: storeHooks([{ u: A }, { u: B }]), webhook_events: null }, 'events').join() === [A, B].join());
check('no settings row: nothing', alertHooks(null, 'boss').length === 0);

// ---- message ids per channel
check('JSON map read as is', parseMsgs('{"111":"m1","222":"m2"}', [A, B])['222'] === 'm2');
check('a bare id saved before lists belongs to the first channel', JSON.stringify(parseMsgs('m9', [B, A])) === '{"222":"m9"}');
check('bare id with no channels: nothing', JSON.stringify(parseMsgs('m9', [])) === '{}');
check('empty map stores NULL', storeMsgs({}) === null);
check('channel removed: its id dropped, others kept', keepMsgs('{"111":"m1","222":"m2"}', [A, B], [B]) === '{"222":"m2"}');
check('channel removed: a bare id follows the channel it belonged to', keepMsgs('m1', [A, B], [B]) === null && keepMsgs('m1', [A, B], [A]) === '{"111":"m1"}');

console.log(`\n${pass}/${pass + fail} checks passed`);
