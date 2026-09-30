// Reading a boss schedule out of OCR text (a Discord schedule post screenshot) and matching it to
// the team's timers. Pure functions: no DOM, no network, no globals, so they run in node tests too.
//
//   29 September 2026
//   2:04 AM | Lady Dalia (85) | @Kongreso
//   11:30 AM | Saphirus (80) | @Senado

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthIndex = (w) => MONTHS.findIndex(m => m.startsWith(String(w).toLowerCase().slice(0, 3)));

// "29 September 2026", "September 29, 2026", "Sep 29" -> { y?, m, d } | null
function parseDate(line) {
    let x = line.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
    if (x && monthIndex(x[2]) >= 0) return { d: +x[1], m: monthIndex(x[2]), y: +x[3] };
    x = line.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?\b/);
    if (x && monthIndex(x[1]) >= 0 && !/\d:\d/.test(line)) return { d: +x[2], m: monthIndex(x[1]), y: x[3] ? +x[3] : undefined };
    return null;
}

// One schedule line -> { h, min, name, level?, tag? } | null. OCR noise around the pipes is tolerated.
function parseRow(line) {
    // AM/PM as OCR really reads it: "AM", "a.m.", "an", "An", "arn", "pn"...
    const t = line.match(/(\d{1,2})\s*[:.]\s*(\d{2})\s*([AaPp])\.?\s*(?:[Mm]|rn|[Nn]|[Hh])?\.?(?![A-Za-z])/) || line.match(/\b(\d{1,2})\s*:\s*(\d{2})\b/);
    if (!t) return null;
    let h = +t[1]; const min = +t[2];
    if (min > 59 || h > 23) return null;
    const ap = t[3]?.toLowerCase();
    if (ap) { if (h > 12 || h === 0) return null; if (ap === 'p' && h !== 12) h += 12; if (ap === 'a' && h === 12) h = 0; }
    const rest = line.slice(t.index + t[0].length);
    const cells = rest.split(/[|¦]/).map(c => c.replace(/^[\s_\-–—.:;,'"`~]+|[\s_\-–—.:;,'"`~]+$/g, '').trim()).filter(Boolean);
    let name = null, level, tag;
    for (const c of cells) {
        if (!tag && /^@/.test(c)) { tag = c.replace(/^@+/, '').split(/\s+/)[0]; continue; }
        if (!name && (c.match(/[A-Za-z]/g) || []).length >= 2) {   // skip OCR crumbs like "n" or "_"
            const lv = c.match(/\((\d{1,4})\)/);
            if (lv) level = +lv[1];
            name = c.replace(/\(\s*\d{1,4}\s*\)?/g, '').replace(/[*_~`]/g, '').trim();
        }
    }
    if (!name || !/[A-Za-z]{2}/.test(name)) return null;
    return { h, min, name, level, tag };
}

// OCR text -> [{ date?: {y?,m,d}, h, min, name, level?, tag?, line }]
export function parseScheduleText(text) {
    const out = [];
    let date = null;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const row = parseRow(line);
        if (row) { out.push({ ...row, date, line }); continue; }
        const d = parseDate(line);
        if (d) date = d;
    }
    return out;
}

// Wall-clock time in a zone -> epoch ms (two passes settle DST edges).
export function zonedToEpoch(y, m, d, h, min, tz) {
    const guess = Date.UTC(y, m, d, h, min);
    const offset = (ts) => {
        const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
            .formatToParts(new Date(ts)).reduce((a, x) => (a[x.type] = x.value, a), {});
        return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - ts;
    };
    let ts = guess - offset(guess);
    ts = guess - offset(ts);
    return ts;
}

// A row's time as epoch ms. With a date header: that day. Without: the next time that clock time
// comes round in the team zone (today, or tomorrow if it has passed by more than `graceMs`).
export function rowTime(row, tz, now = Date.now(), graceMs = 10 * 60000) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)).split('-').map(Number);
    if (row.date) {
        const y = row.date.y ?? today[0];
        return zonedToEpoch(y, row.date.m, row.date.d, row.h, row.min, tz);
    }
    let ts = zonedToEpoch(today[0], today[1] - 1, today[2], row.h, row.min, tz);
    if (ts < now - graceMs) ts += 86400000;
    return ts;
}

// ---- name matching (OCR slips like "lcaruthia" for "Icaruthia")

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
// OCR confusables folded together before comparing
const fold = (s) => norm(s).replace(/[il1|]/g, 'i').replace(/[o0]/g, 'o').replace(/rn/g, 'm').replace(/[5s]/g, 's');

function distance(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return dp[a.length][b.length];
}

// Best candidate by name: exact (ignoring case/punctuation), then OCR-folded, then within a small
// edit distance (1 for short names, 2 for 8+ letters). -> { item, exact } | null
export function matchName(name, candidates, nameOf = (c) => c.name) {
    const n = norm(name), f = fold(name);
    if (!n) return null;
    let hit = candidates.find(c => norm(nameOf(c)) === n);
    if (hit) return { item: hit, exact: true };
    hit = candidates.find(c => fold(nameOf(c)) === f);
    if (hit) return { item: hit, exact: false };
    const limit = f.length >= 8 ? 2 : 1;
    let best = null, bestD = Infinity;
    for (const c of candidates) {
        const d = distance(f, fold(nameOf(c)));
        if (d < bestD) { best = c; bestD = d; }
    }
    return best && bestD <= limit ? { item: best, exact: false } : null;
}

// Parsed rows -> review plan. A timer holds its next spawn, so per boss the earliest time that is
// not past sets it; the boss's later lines ("later") hand their groups to the 2nd, 3rd... spawn.
//   bosses: team timers [{ id, name, ... }], presets: [{ name, type, intervalMs, ... }], groups: [{ id, name }]
// -> [{ row, at, action: 'update'|'add'|'later'|'skip', reason?, boss?, preset?, group?, groupUnknown?, checked, key }]
export function buildPlan(rows, { bosses, presets, groups, tz, now = Date.now(), graceMs = 10 * 60000 }) {
    const plan = rows.map(row => {
        const at = rowTime(row, tz, now, graceMs);
        const m = matchName(row.name, bosses);
        const p = m ? null : matchName(row.name, presets);
        const g = row.tag ? matchName(row.tag, groups) : null;
        const item = { row, at, boss: m?.item || null, preset: p?.item || null, fuzzy: !!(m && !m.exact) || !!(p && !p.exact),
            group: g?.item || null, groupUnknown: !!(row.tag && !g) };
        item.key = item.boss ? 'b:' + item.boss.id : item.preset ? 'p:' + norm(item.preset.name) : 'n:' + norm(row.name);
        if (at < now - graceMs) return { ...item, action: 'skip', reason: 'already past', checked: false };
        return { ...item, action: item.boss ? 'update' : 'add', checked: true };
    });
    // per boss: the earliest upcoming line sets the timer; the ones after it are its later spawns
    const firstAt = new Map();
    for (const p of plan) if (p.action !== 'skip' && (!firstAt.has(p.key) || p.at < firstAt.get(p.key))) firstAt.set(p.key, p.at);
    for (const p of plan) {
        if (p.action !== 'skip' && p.at !== firstAt.get(p.key)) Object.assign(p, { action: 'later', reason: 'later spawn: sets its group' });
    }
    // a brand-new boss with no preset needs its respawn time from the officer
    for (const p of plan) if (p.action === 'add' && !p.preset) p.needsRule = true;
    return plan;
}

// After a maintenance reset, a screenshot of the schedule from before maintenance would put the old
// times back on the bosses the reset brought up (how 7 bosses lost their reset on 2026-09-30). A line
// is from before maintenance when its boss is still on the reset (next spawn = server open) and its
// time cannot come from a kill after the server opened: earlier than open + the respawn time for a
// respawn timer, earlier than open for a fixed schedule. Those lines start unticked; the officer can
// still tick them. maintenance = { at: server open } from GET /bosses; a reset over a day old is history.
// -> number of lines marked
export const MAINTENANCE_RECENT_MS = 24 * 3600000;
export function markPreMaintenance(plan, maintenance, now = Date.now()) {
    const open = maintenance?.at;
    if (!open || now - open > MAINTENANCE_RECENT_MS) return 0;
    let n = 0;
    for (const p of plan) {
        const b = p.boss;
        if (p.action !== 'update' || !b || b.next_spawn !== open) continue;
        if (p.at >= open + (b.type === 'interval' ? b.interval_ms || 0 : 0)) continue;
        Object.assign(p, { checked: false, preMaintenance: true, reason: 'from before the maintenance reset' });
        n++;
    }
    return n;
}

// Groups of a boss's later lines, in time order, for the import request (up to 3).
export function laterGroupsFor(plan, first) {
    return plan.filter(p => p !== first && p.key === first.key && p.action === 'later' && p.checked)
        .sort((a, b) => a.at - b.at).slice(0, 3).map(p => p.group?.id || null);
}
