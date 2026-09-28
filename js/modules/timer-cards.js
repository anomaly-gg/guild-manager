// Shared timer-card rendering. Used by the Timers module (app) and timers.html (public page).
// Pure functions: no globals, no network.

export const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RING_R = 24;
const RING_C = 2 * Math.PI * RING_R; // circumference

export function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function fmtCountdown(ms) {
    if (ms <= 0) return '0:00';
    const t = Math.floor(ms / 1000);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function fmtDuration(ms) {
    const min = Math.round(ms / 60000);
    const h = Math.floor(min / 60), m = min % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
}

function parseJson(v, fallback) {
    if (v == null) return fallback;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return fallback; }
}

export function scheduleText(boss) {
    switch (boss.type) {
        case 'interval': return 'Every ' + fmtDuration(boss.interval_ms || 0);
        case 'fixed': return 'Daily ' + (boss.fixed_time || '');
        case 'weekly': return `${DAY[boss.weekly_day] ?? ''} ${boss.weekly_time || ''}`;
        case 'twicedaily': return 'Daily ' + (parseJson(boss.biweekly_days, []) || []).join(' & ');
        case 'biweekly': return (parseJson(boss.biweekly_days, []) || []).map(d => `${DAY[d.day] ?? ''} ${d.time}`).join(' & ');
        default: return '';
    }
}

// State of a boss at `now`.
//   waiting → soon (inside the alert window) → window (spawn window open, if window_ms) → spawned
export function bossState(boss, now = Date.now()) {
    const remaining = boss.next_spawn - now;
    const alertMs = (boss.alert_minutes || 5) * 60000;
    const windowMs = boss.window_ms || 0;
    const isUp = boss.status === 'spawned' || remaining <= 0;
    let key = 'waiting', windowLeft = 0;
    if (isUp) {
        if (windowMs > 0 && now < boss.next_spawn + windowMs) { key = 'window'; windowLeft = boss.next_spawn + windowMs - now; }
        else key = 'spawned';
    } else if (remaining <= alertMs) {
        key = 'soon';
    }
    // ring progress: how much of the wait has elapsed
    let total = boss.type === 'interval' && boss.interval_ms ? boss.interval_ms
        : (boss.last_death ? boss.next_spawn - boss.last_death : 86400000);
    if (!(total > 0)) total = 86400000;
    const fraction = isUp ? 1 : Math.min(1, Math.max(0, (total - remaining) / total));
    return { key, remaining, windowLeft, fraction, alertMs };
}

const ICON = {
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="M13 7l4 4"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

const CHIP = {
    waiting: '',
    soon: '<span class="chip chip-warn">Soon</span>',
    window: '<span class="chip chip-danger">Window open</span>',
    spawned: '<span class="chip chip-danger">Spawned</span>',
};

export function stateIcon(key) {
    if (key === 'spawned' || key === 'window') return '&#9888;';
    return '';
}

// Zone the row clocks are shown in (undefined = the device zone). The app sets it from the
// viewer's preference; the public page leaves it on the device.
let displayZone;
export function setDisplayTimeZone(tz) { displayZone = tz || undefined; }
const zoned = (opts) => displayZone ? { ...opts, timeZone: displayZone } : opts;

function timeAt(ts) {
    return new Date(ts).toLocaleTimeString([], zoned({ hour: 'numeric', minute: '2-digit' }));
}

function countdownText(boss, st) {
    if (st.key === 'spawned') return 'UP';
    if (st.key === 'window') return fmtCountdown(st.windowLeft);
    return fmtCountdown(st.remaining);
}

function atText(boss, st) {
    if (st.key === 'spawned') return 'since ' + timeAt(boss.next_spawn);
    if (st.key === 'window') return 'window closes';
    return 'at ' + timeAt(boss.next_spawn);
}

// Spawn group of the boss's next spawn. Officers get a chip that opens the groups dialog
// (next / 2nd / 3rd spawn + alternate); "+N" = later spawns picked, "⇄" = alternates.
function groupHtml(boss, opts) {
    const groups = opts.groups || [];
    if (!groups.length) return '';
    const current = groups.find(g => g.id === boss.spawn_group);
    let later = 0;
    try { later = (JSON.parse(boss.later_groups || '[]') || []).filter(Boolean).length; } catch { /* bad json = none */ }
    const extra = `${later ? ` +${later}` : ''}${boss.alternate_groups ? ' ⇄' : ''}`;
    if (opts.canManage && !opts.readOnly) {
        return `<button type="button" class="tcard-group ${current ? 'is-set' : ''}" data-action="groups" data-id="${boss.id}" title="Groups for the coming spawns">${current ? '@' + esc(current.name) : '+ Group'}${extra}</button>`;
    }
    return current || extra ? `<span class="chip chip-accent tcard-group-tag">${current ? '@' + esc(current.name) : ''}${extra}</span>` : '';
}

// Full card. opts: { readOnly, canManage, groups }
export function cardHtml(boss, opts = {}, now = Date.now()) {
    const st = bossState(boss, now);
    // Schedules are written in the team zone; say so when the viewer's clock differs (opts.teamTimeNote).
    const sched = scheduleText(boss);
    const schedNote = sched && boss.type !== 'interval' && opts.teamTimeNote ? ` <span class="tcard-tz">${esc(opts.teamTimeNote)}</span>` : '';
    const meta = [sched ? sched + schedNote : '', boss.location ? esc(boss.location) : ''].filter(Boolean).join(' · ');
    const sub = boss.last_death ? `Killed ${new Date(boss.last_death).toLocaleString([], zoned({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}` : 'No kill logged yet';
    const windowNote = boss.window_ms ? ` · window ${fmtDuration(boss.window_ms)}` : '';
    const actions = opts.readOnly ? '' : `
        <div class="tcard-actions">
            <button class="btn btn-sm tbtn-kill" data-action="kill" data-id="${boss.id}">Killed</button>
            <button class="tbtn-icon tcard-more" data-action="more" data-id="${boss.id}" title="More">${ICON.more}</button>
            <div class="tcard-secondary">
                <button class="tbtn-icon" data-action="settime" data-id="${boss.id}" title="Set kill time">${ICON.clock}</button>
                ${opts.canManage ? `<button class="tbtn-icon" data-action="edit" data-id="${boss.id}" title="Edit">${ICON.edit}</button>
                <button class="tbtn-icon tbtn-icon-danger" data-action="delete" data-id="${boss.id}" title="Remove timer">${ICON.x}</button>` : ''}
            </div>
        </div>`;
    return `
        <article class="tcard state-${st.key}" data-boss-id="${boss.id}">
            <div class="tcard-ring">
                <svg viewBox="0 0 56 56" aria-hidden="true">
                    <circle class="ring-bg" cx="28" cy="28" r="${RING_R}"/>
                    <circle class="ring-fg" cx="28" cy="28" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="${(RING_C * (1 - st.fraction)).toFixed(1)}"/>
                </svg>
                <span class="tcard-icon">${stateIcon(st.key)}</span>
            </div>
            <div class="tcard-body">
                <div class="tcard-top"><h4 class="tcard-name">${esc(boss.name)}</h4><span class="tcard-chip">${CHIP[st.key]}</span></div>
                <div class="tcard-meta">${meta}${windowNote}</div>
                <div class="tcard-sub">${groupHtml(boss, opts)}<span class="tcard-sub-text" title="${esc(sub)}">${sub}</span></div>
            </div>
            <div class="tcard-right">
                <div class="tcard-countdown">${countdownText(boss, st)}</div>
                <div class="tcard-at">${atText(boss, st)}</div>
            </div>
            ${actions}
        </article>`;
}

// Cheap per-second update of an existing card element.
export function updateCard(el, boss, now = Date.now()) {
    const st = bossState(boss, now);
    const cls = 'tcard state-' + st.key + (el.classList.contains('open') ? ' open' : '');
    if (el.className !== cls) {
        el.className = cls;
        const chip = el.querySelector('.tcard-chip'); if (chip) chip.innerHTML = CHIP[st.key];
        const icon = el.querySelector('.tcard-icon'); if (icon) icon.innerHTML = stateIcon(st.key);
        const at = el.querySelector('.tcard-at'); if (at) at.textContent = atText(boss, st);
    }
    const cd = el.querySelector('.tcard-countdown'); if (cd) cd.textContent = countdownText(boss, st);
    const ring = el.querySelector('.ring-fg'); if (ring) ring.setAttribute('stroke-dashoffset', (RING_C * (1 - st.fraction)).toFixed(1));
}

// Time groups for long lists: Up now / Next hour / Later today / Tomorrow / Later.
// Headers only appear once the list is long enough to need them (minForGroups).
export function groupedListHtml(list, opts, now = Date.now(), minForGroups = 8) {
    const sorted = sortBosses(list, now);
    if (sorted.length < minForGroups) return sorted.map(b => cardHtml(b, opts, now)).join('');
    const endOfToday = new Date(now); endOfToday.setHours(24, 0, 0, 0);
    const endOfTomorrow = endOfToday.getTime() + 86400000;
    const groupOf = (b) => {
        const st = bossState(b, now);
        if (st.key === 'spawned' || st.key === 'window') return 'Up now';
        if (st.remaining <= 3600000) return 'Next hour';
        if (b.next_spawn < endOfToday.getTime()) return 'Later today';
        if (b.next_spawn < endOfTomorrow) return 'Tomorrow';
        return 'Later';
    };
    let current = null, html = '';
    for (const b of sorted) {
        const g = groupOf(b);
        if (g !== current) { current = g; html += `<h3 class="t-group">${g}</h3>`; }
        html += cardHtml(b, opts, now);
    }
    return html;
}

// Sort: spawned / window first, then soonest.
export function sortBosses(list, now = Date.now()) {
    const rank = { spawned: 0, window: 0, soon: 1, waiting: 1 };
    return [...list].sort((a, b) => {
        const sa = bossState(a, now), sb = bossState(b, now);
        if (rank[sa.key] !== rank[sb.key]) return rank[sa.key] - rank[sb.key];
        return a.next_spawn - b.next_spawn;
    });
}
