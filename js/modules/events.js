// Events module: dense event rows with RSVP by role, sign-up caps, week view, lineup, attendance,
// templates (premium), attendance report (premium), iCal feed.
// ES module. Uses shell globals by name (teamData, teamTab, currentTeamId, currentUser, api, token,
// showToast, guard, renderTeamView, API). Exposed as window.Events.

import { esc } from './timer-cards.js?v=20260924e';
import { loadAttendance, attendanceHtml, onAttendanceClick, onAttendanceInput, onAttendanceToggle } from './attendance.js?v=20260924e';

const DEFAULT_ROLES = ['Tank', 'Healer', 'DPS', 'Support'];
const TYPE_LABEL = { raid: 'Raid', scrim: 'Scrim', gvg: 'GvG', dungeon: 'Dungeon', meeting: 'Meeting', other: 'Event' };
const REPEAT_LABEL = { daily: 'Daily', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' };

let events = [], rsvps = [], roles = DEFAULT_ROLES, avail = [];
let view = localStorage.getItem('gm_events_view') || 'list';
let weekAnchor = Date.now();
let expanded = new Set();
let showPast = false;
let tickTimer = null, refreshTimer = null;

const root = () => document.getElementById('eventsContent');
const modalHost = () => document.getElementById('deathModal');
const isPremium = () => !!teamData?.team?.premium_team;
const isOfficer = () => { const r = teamData?.team?.my_role; return r === 'leader' || r === 'officer'; };
const canEdit = (e) => isOfficer() || e.created_by === currentUser?.id;
const byId = (id) => events.find(e => e.id === id);
const endOf = (e) => e.event_time + (e.duration_minutes || 60) * 60000;
const isLive = (e, now = Date.now()) => e.event_time <= now && endOf(e) > now;
const isPast = (e, now = Date.now()) => endOf(e) <= now;

// ---------------------------------------------------------------- open / data

export async function open() {
    teamTab = 'events';
    renderTeamView();
    await load();
    if (teamTab !== 'events') return;
    if (view === 'attendance') { render(); await loadAttendance(); if (teamTab !== 'events') return; }
    render();
    startLoops();
}

async function load() {
    const [d, s, a] = await Promise.all([
        api('GET', `/api/teams/${currentTeamId}/events`),
        api('GET', `/api/teams/${currentTeamId}/settings`).catch(() => ({})),
        api('GET', `/api/teams/${currentTeamId}/availability`).catch(() => ({})),
    ]);
    events = d.events || [];
    rsvps = d.rsvps || [];
    avail = a?.slots || [];
    roles = Array.isArray(s?.rsvpRoles) && s.rsvpRoles.length ? s.rsvpRoles : DEFAULT_ROLES;
}

async function reload() {
    await load();
    if (teamTab === 'events') render();
}

function startLoops() {
    stopLoops();
    tickTimer = setInterval(() => {
        if (teamTab !== 'events' || !root()) return stopLoops();
        const now = Date.now();
        for (const e of events) {
            const el = root().querySelector(`[data-event-id="${e.id}"] [data-role="cd"]`);
            if (el) el.innerHTML = countdownHtml(e, now);
        }
    }, 30000);
    refreshTimer = setInterval(async () => {
        if (teamTab !== 'events' || !root()) return stopLoops();
        await load();
        if (teamTab === 'events') render();
    }, 60000);
}
function stopLoops() {
    if (tickTimer) clearInterval(tickTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    tickTimer = refreshTimer = null;
}

// ---------------------------------------------------------------- formatting

function fmtRel(ms) {
    const abs = Math.abs(ms), m = Math.round(abs / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60), r = m % 60;
    if (h < 24) return r ? `${h}h ${r}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return d === 1 ? '1 day' : `${d} days`;
}
function countdownHtml(e, now = Date.now()) {
    if (isLive(e, now)) return '<span class="chip chip-danger">Live now</span>';
    if (isPast(e, now)) return '<span class="e-dim">ended</span>';
    return `in ${fmtRel(e.event_time - now)}`;
}
function timeStr(ms) { return new Date(ms).toLocaleTimeString([], tzOpts({ hour: 'numeric', minute: '2-digit' })); }
function dateStr(ms) { return new Date(ms).toLocaleDateString([], tzOpts({ weekday: 'short', month: 'short', day: 'numeric' })); }
// "· 21:00 team time" when the viewer's clock differs from the team zone and times are shown device-side.
function teamTimeNote(ms) { return tzDiffers() && tzMode() === 'device' ? ` <span class="e-tz">${teamTimeStr(ms)} team time</span>` : ''; }
function pad(n) { return String(n).padStart(2, '0'); }
function toLocalInput(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }

function rsvpsFor(id) { return rsvps.filter(r => r.event_id === id); }
function roleCounts(id) {
    const counts = {};
    for (const r of rsvpsFor(id)) if (r.status === 'going') counts[r.role || 'Unassigned'] = (counts[r.role || 'Unassigned'] || 0) + 1;
    return counts;
}
function usuallyFree(e) {
    const d = new Date(e.event_time);
    const day = d.getDay();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const names = new Set();
    for (const s of avail) if (s.day === day && s.start_time <= hm && hm < s.end_time) names.add(s.username);
    return [...names];
}
function parseLineup(e) { try { return e.lineup ? JSON.parse(e.lineup) : []; } catch { return []; } }
function memberName(userId) { return teamData?.members?.find(m => m.id === userId)?.username || '—'; }

// ---------------------------------------------------------------- render

function renderBody() { const b = root()?.querySelector('[data-role="body"]'); if (b) b.innerHTML = view === 'attendance' ? attendanceHtml() : view === 'week' ? weekHtml() : listHtml(); }

function render() {
    const el = root();
    if (!el) return;
    const more = [
        `<button class="menu-item" data-action="ical">Calendar feed (.ics)${isPremium() ? '' : ' <span class="chip chip-accent">Premium</span>'}</button>`,
        isPremium() ? `<button class="menu-item" data-action="report">Attendance report</button>` : '',
    ].filter(Boolean).join('');
    el.innerHTML = `
        <div class="timers-toolbar">
            <div class="sub-nav e-viewswitch">
                <button class="${view === 'list' ? 'active' : ''}" data-action="view" data-view="list">List</button>
                <button class="${view === 'week' ? 'active' : ''}" data-action="view" data-view="week">Week</button>
                <button class="${view === 'attendance' ? 'active' : ''}" data-action="view" data-view="attendance">Attendance</button>
            </div>
            <div class="header-spacer"></div>
            <button class="btn btn-primary" data-action="add">+ New event</button>
            <details class="menu" data-role="menu"><summary class="btn btn-secondary" title="More">&#8943;</summary><div class="menu-list">${more}</div></details>
        </div>
        <div data-role="body">${view === 'attendance' ? attendanceHtml() : view === 'week' ? weekHtml() : listHtml()}</div>`;
    el.onclick = onClick;
    // attendance search re-renders only the day list, so the input keeps focus
    el.oninput = (e) => {
        if (onAttendanceInput(e.target) === 'list') {
            const tmp = document.createElement('div'); tmp.innerHTML = attendanceHtml();
            const days = el.querySelector('.att-days'); const fresh = tmp.querySelector('.att-days');
            if (days && fresh) days.replaceWith(fresh);
        }
    };
    if (!el._attToggle) { el._attToggle = true; el.addEventListener('toggle', (e) => { if (e.target.classList && e.target.classList.contains('att-day')) onAttendanceToggle(e.target); }, true); }
    el.onchange = onChange;
}

function rerenderBody() {
    const b = root()?.querySelector('[data-role="body"]');
    if (b) b.innerHTML = view === 'attendance' ? attendanceHtml() : view === 'week' ? weekHtml() : listHtml();
}

function listHtml() {
    const now = Date.now();
    const upcoming = events.filter(e => !isPast(e, now)).sort((a, b) => (isLive(b, now) - isLive(a, now)) || a.event_time - b.event_time);
    const past = events.filter(e => isPast(e, now)).sort((a, b) => b.event_time - a.event_time);
    let html = '';
    if (upcoming.length === 0 && past.length === 0) {
        return `<div class="t-empty card"><div class="t-empty-title">No events yet</div>
            <div class="t-empty-sub">Plan raids, GvGs and scrims here. Members RSVP by role, Discord gets a reminder, and you can mark attendance afterwards.</div>
            <button class="btn btn-primary" data-action="add">+ Create the first event</button></div>`;
    }
    if (upcoming.length === 0) html += '<div class="e-section-empty">Nothing upcoming. <button class="btn btn-sm btn-secondary" data-action="add">+ New event</button></div>';
    html += '<div class="erows">' + upcoming.map(e => rowHtml(e, now)).join('') + '</div>';
    if (past.length) {
        html += `<button class="e-past-toggle" data-action="togglepast">${showPast ? '▾' : '▸'} Past events (${past.length})</button>`;
        if (showPast) html += '<div class="erows erows-past">' + past.slice(0, 20).map(e => rowHtml(e, now)).join('') + '</div>';
    }
    return html;
}

function chipsHtml(e, now) {
    const full = e.max_going > 0 && e.going_count >= e.max_going;
    return [
        `<span class="chip chip-muted e-type e-type-${esc(e.event_type)}">${TYPE_LABEL[e.event_type] || esc(e.event_type)}</span>`,
        e.recurrence ? `<span class="chip chip-accent">${REPEAT_LABEL[e.recurrence] || e.recurrence}</span>` : '',
        full ? '<span class="chip chip-warn">Full</span>' : '',
    ].filter(Boolean).join('');
}

function peopleHtml(e) {
    const counts = roleCounts(e.id);
    const roleBits = Object.entries(counts).filter(([k]) => k !== 'Unassigned').map(([k, n]) => `<span class="e-rolecount">${esc(k)} <b>${n}</b></span>`).join('');
    const cap = e.max_going > 0 ? `/${e.max_going}` : '';
    return `<b>${e.going_count}${cap}</b> going${e.maybe_count ? ` · ${e.maybe_count} maybe` : ''}${roleBits ? ' · ' + roleBits : ''}`;
}

function rsvpControlHtml(e, now) {
    if (isPast(e, now)) {
        const mine = e.my_rsvp === 'going' ? 'You were going' : e.my_rsvp === 'maybe' ? 'You were a maybe' : e.my_rsvp === 'not_going' ? "You couldn't" : 'No RSVP';
        return `<span class="e-dim">${mine}</span>`;
    }
    const seg = (status, label) => `<button class="${e.my_rsvp === status ? 'active st-' + status : ''}" data-action="rsvp" data-id="${e.id}" data-status="${status}">${label}</button>`;
    const roleSel = (e.my_rsvp === 'going' || e.my_rsvp === 'maybe') && roles.length ? `
        <select class="e-roleselect" data-role="rsvprole" data-id="${e.id}" title="Your role">
            <option value="">Role…</option>
            ${roles.map(r => `<option value="${esc(r)}" ${e.my_role === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
        </select>` : '';
    return `<div class="e-seg">${seg('going', 'Going')}${seg('maybe', 'Maybe')}${seg('not_going', "Can't")}</div>${roleSel}`;
}

function rowHtml(e, now = Date.now()) {
    const d = new Date(e.event_time);
    const open = expanded.has(e.id);
    return `
        <article class="erow ${isLive(e, now) ? 'live' : ''} ${isPast(e, now) ? 'past' : ''} ${open ? 'open' : ''}" data-event-id="${e.id}">
            <div class="erow-date" data-action="toggle" data-id="${e.id}">
                <span class="d-dow">${d.toLocaleDateString([], tzOpts({ weekday: 'short' }))}</span>
                <span class="d-day">${d.toLocaleDateString([], tzOpts({ day: 'numeric' }))}</span>
                <span class="d-mon">${d.toLocaleDateString([], tzOpts({ month: 'short' }))}</span>
            </div>
            <div class="erow-body" data-action="toggle" data-id="${e.id}">
                <div class="erow-top"><h4 class="erow-title">${esc(e.title)}</h4>${chipsHtml(e, now)}</div>
                <div class="erow-meta">${timeStr(e.event_time)}${teamTimeNote(e.event_time)} · ${e.duration_minutes || 60} min · <span data-role="cd">${countdownHtml(e, now)}</span></div>
                <div class="erow-people">${peopleHtml(e)}</div>
            </div>
            <div class="erow-rsvp">${rsvpControlHtml(e, now)}</div>
            <button class="tbtn-icon erow-chevron" data-action="toggle" data-id="${e.id}" title="Details">${open ? '▴' : '▾'}</button>
            ${open ? `<div class="erow-details">${detailsHtml(e, now)}</div>` : ''}
        </article>`;
}

function detailsHtml(e, now = Date.now()) {
    const list = rsvpsFor(e.id);
    const going = list.filter(r => r.status === 'going');
    const maybe = list.filter(r => r.status === 'maybe');
    const out = list.filter(r => r.status === 'not_going');
    const byRole = {};
    for (const r of going) (byRole[r.role || 'Unassigned'] ||= []).push(r.username);
    const roleOrder = [...roles.filter(r => byRole[r]), ...Object.keys(byRole).filter(k => !roles.includes(k))];
    const goingHtml = going.length ? roleOrder.map(r => `<div class="e-rolegroup"><span class="e-rolename">${esc(r)} <b>${byRole[r].length}</b></span><span class="e-names">${byRole[r].map(esc).join(', ')}</span></div>`).join('') : '<span class="e-dim">Nobody yet</span>';
    const lineup = parseLineup(e);
    const lineupHtml = lineup.length ? `<div class="e-lineup">${lineup.map(s => `<div class="e-slot"><span class="e-slot-role">${esc(s.role)}</span><span class="e-slot-user ${s.userId ? '' : 'empty'}">${s.userId ? esc(memberName(s.userId)) : 'open'}</span></div>`).join('')}</div>` : '';
    const actions = [
        canEdit(e) ? `<button class="btn btn-sm btn-secondary" data-action="edit" data-id="${e.id}">Edit</button>` : '',
        isOfficer() ? `<button class="btn btn-sm btn-secondary" data-action="lineup" data-id="${e.id}">${lineup.length ? 'Edit lineup' : 'Set lineup'}</button>` : '',
        isOfficer() && (isPast(e, now) || isLive(e, now)) ? `<button class="btn btn-sm btn-secondary" data-action="attendance" data-id="${e.id}">Attendance</button>` : '',
        isOfficer() && isPremium() ? `<button class="btn btn-sm btn-secondary" data-action="savetpl" data-id="${e.id}">Save as template</button>` : '',
        canEdit(e) ? `<button class="btn btn-sm btn-danger" data-action="delete" data-id="${e.id}">Delete</button>` : '',
    ].filter(Boolean).join('');
    return `
        ${e.description ? `<p class="e-desc">${esc(e.description)}</p>` : ''}
        <div class="e-detail-grid">
            <div><div class="t-h3">Going (${going.length}${e.max_going ? ` of ${e.max_going}` : ''})</div>${goingHtml}</div>
            <div>
                ${maybe.length ? `<div class="t-h3">Maybe (${maybe.length})</div><div class="e-names">${maybe.map(r => esc(r.username)).join(', ')}</div>` : ''}
                ${out.length ? `<div class="t-h3">Can't (${out.length})</div><div class="e-names e-dim">${out.map(r => esc(r.username)).join(', ')}</div>` : ''}
            </div>
        </div>
        ${lineupHtml ? `<div class="t-h3">Lineup</div>${lineupHtml}` : ''}
        ${(() => { const f = usuallyFree(e); return avail.length ? `<div class="e-avail-hint">Usually free at this time: <b>${f.length}</b>${f.length ? ' · ' + f.map(esc).join(', ') : ''}</div>` : ''; })()}
        <div class="e-detail-foot"><span class="e-dim">${dateStr(e.event_time)} · created by ${esc(e.creator_name || '')}</span><div class="e-actions">${actions}</div></div>`;
}

// ---------------------------------------------------------------- week view

function startOfWeek(ms) {
    const d = new Date(ms); d.setHours(0, 0, 0, 0);
    const day = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - day);
    return d.getTime();
}

function weekHtml() {
    const now = Date.now();
    const start = startOfWeek(weekAnchor);
    const days = Array.from({ length: 7 }, (_, i) => start + i * 86400000);
    const end = start + 7 * 86400000;
    const label = `${new Date(start).toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(end - 1).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
    const todayStart = startOfWeek(now) === start ? new Date(now).setHours(0, 0, 0, 0) : null;
    const cols = days.map(dayStart => {
        const dayEnd = dayStart + 86400000;
        const list = events.filter(e => e.event_time >= dayStart && e.event_time < dayEnd).sort((a, b) => a.event_time - b.event_time);
        const d = new Date(dayStart);
        return `<div class="wk-day ${dayStart === todayStart ? 'today' : ''}">
            <div class="wk-head"><span>${d.toLocaleDateString([], { weekday: 'short' })}</span><b>${d.getDate()}</b></div>
            ${list.map(e => `<button class="wk-ev ${isLive(e, now) ? 'live' : ''} ${isPast(e, now) ? 'past' : ''} st-${e.my_rsvp || 'none'}" data-action="peek" data-id="${e.id}">
                <span class="wk-time">${timeStr(e.event_time)}</span><span class="wk-title">${esc(e.title)}</span><span class="wk-going">${e.going_count}${e.max_going ? '/' + e.max_going : ''}</span>
            </button>`).join('') || '<div class="wk-empty"></div>'}
        </div>`;
    }).join('');
    return `
        <div class="wk-nav">
            <button class="btn btn-sm btn-secondary" data-action="week" data-dir="-1">&#8249;</button>
            <button class="btn btn-sm btn-secondary" data-action="week" data-dir="0">This week</button>
            <button class="btn btn-sm btn-secondary" data-action="week" data-dir="1">&#8250;</button>
            <span class="wk-label">${label}</span>
        </div>
        <div class="wk-grid">${cols}</div>`;
}

// ---------------------------------------------------------------- events

async function onClick(ev) {
    const attBtn = ev.target.closest('[data-att]');
    if (attBtn && root()?.contains(attBtn)) { if (await onAttendanceClick(attBtn)) renderBody(); return; }
    const btn = ev.target.closest('[data-action]');
    if (!btn || !root()?.contains(btn)) return;
    const menu = root().querySelector('[data-role="menu"]');
    if (menu && menu.open && !menu.contains(btn)) menu.open = false;
    const id = btn.dataset.id;
    switch (btn.dataset.action) {
        case 'view': view = btn.dataset.view; localStorage.setItem('gm_events_view', view); if (view === 'attendance') { render(); await loadAttendance(); } render(); break;
        case 'add': openEventModal(null); break;
        case 'edit': openEventModal(byId(id)); break;
        case 'toggle': expanded.has(id) ? expanded.delete(id) : expanded.add(id); rerenderBody(); break;
        case 'togglepast': showPast = !showPast; rerenderBody(); break;
        case 'rsvp': rsvp(id, btn.dataset.status); break;
        case 'delete': deleteEvent(id); break;
        case 'lineup': openLineupModal(byId(id)); break;
        case 'attendance': openAttendanceModal(byId(id)); break;
        case 'savetpl': saveTemplate(byId(id)); break;
        case 'peek': expanded.add(id); view = 'list'; localStorage.setItem('gm_events_view', view); render(); root().querySelector(`[data-event-id="${id}"]`)?.scrollIntoView({ block: 'center' }); break;
        case 'week': weekAnchor = btn.dataset.dir === '0' ? Date.now() : weekAnchor + Number(btn.dataset.dir) * 7 * 86400000; rerenderBody(); break;
        case 'ical': isPremium() ? window.open(`${API}/api/teams/${currentTeamId}/events/export?token=${encodeURIComponent(token)}`, '_blank') : showUpgradeModal(); break;
        case 'report': showReport(); break;
    }
    if (menu && btn.closest('.menu-list')) menu.open = false;
}

function onChange(ev) {
    const sel = ev.target;
    if (sel.dataset.role === 'rsvprole') {
        const e = byId(sel.dataset.id);
        if (e) rsvp(e.id, e.my_rsvp || 'going', sel.value || null);
    }
}

const rsvp = guard('events.rsvp', async (id, status, role) => {
    const e = byId(id);
    const body = { status };
    body.role = role !== undefined ? role : (e?.my_role || null);
    const res = await api('POST', `/api/teams/${currentTeamId}/events/${id}/rsvp`, body);
    if (res.error) { showToast(res.error); return; }
    await reload();
});

const deleteEvent = guard('events.delete', async (id) => {
    const e = byId(id);
    if (!(await confirmDialog(`Delete "${e?.title || 'this event'}"?`, { confirmLabel: 'Delete' }))) return;
    const res = await api('DELETE', `/api/teams/${currentTeamId}/events/${id}`);
    if (res.error) { showToast(res.error); return; }
    expanded.delete(id);
    showToast('Event deleted');
    await reload();
});

// ---------------------------------------------------------------- modals

function closeModal() { modalHost().innerHTML = ''; }
function modal(inner, { wide } = {}) {
    modalHost().innerHTML = `<div class="modal-backdrop" data-close="1"><div class="card modal-card ${wide ? 'modal-wide' : ''}">${inner}</div></div>`;
    const back = modalHost().firstElementChild;
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]:not(.modal-backdrop)')) closeModal(); });
    return back;
}

async function openEventModal(e) {
    let templates = [];
    if (!e && isPremium()) { const t = await api('GET', `/api/teams/${currentTeamId}/event-templates`).catch(() => ({})); templates = t.templates || []; }
    const defaultTime = e ? toLocalInput(e.event_time) : toLocalInput(Math.ceil((Date.now() + 3600000) / 1800000) * 1800000);
    const back = modal(`
        <h2>${e ? 'Edit event' : 'New event'}</h2>
        <form class="tform" id="eventForm">
            ${templates.length ? `<label class="tf-field tf-wide"><span>Start from template</span><select id="efTemplate"><option value="">—</option>${templates.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>` : ''}
            <label class="tf-field tf-wide"><span>Title</span><input id="efTitle" maxlength="100" required value="${esc(e?.title || '')}" placeholder="e.g. Castle Siege"></label>
            <label class="tf-field"><span>Type</span><select id="efType">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${(e?.event_type || 'raid') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
            <label class="tf-field"><span>Repeat</span><select id="efRepeat"><option value="">No repeat</option>${Object.entries(REPEAT_LABEL).map(([k, v]) => `<option value="${k}" ${e?.recurrence === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
            <label class="tf-field"><span>Date &amp; time <em>${tzDiffers() ? 'your device time' : ''}</em></span><input id="efTime" type="datetime-local" required value="${defaultTime}"></label>
            <label class="tf-field"><span>Duration <em>minutes</em></span><input id="efDuration" type="number" min="5" max="1440" value="${e?.duration_minutes ?? 60}"></label>
            <label class="tf-field"><span>Sign-up cap <em>0 = none</em></span><input id="efCap" type="number" min="0" max="500" value="${e?.max_going ?? 0}"></label>
            ${!e && roles.length ? `<label class="tf-field"><span>Your role</span><select id="efMyRole"><option value="">—</option>${roles.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select></label>` : ''}
            <label class="tf-field tf-wide"><span>Description <em>optional</em></span><input id="efDesc" maxlength="2000" value="${esc(e?.description || '')}" placeholder="Meeting point, requirements, links"></label>
            <div class="tf-actions tf-wide"><button type="button" class="btn btn-secondary" data-close="1">Cancel</button><button type="submit" class="btn btn-primary">${e ? 'Save changes' : 'Create event'}</button></div>
        </form>`);
    const form = back.querySelector('#eventForm');
    form.querySelector('#efTemplate')?.addEventListener('change', (ev) => {
        const t = templates.find(x => x.id === ev.target.value); if (!t) return;
        form.querySelector('#efTitle').value = t.title; form.querySelector('#efType').value = t.event_type || 'other';
        form.querySelector('#efDuration').value = t.duration_minutes || 60; form.querySelector('#efRepeat').value = t.recurrence || '';
        form.querySelector('#efDesc').value = t.description || '';
    });
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const v = (id) => form.querySelector('#' + id)?.value;
        const eventTime = new Date(v('efTime')).getTime();
        if (!v('efTitle').trim()) { showToast('Title required'); return; }
        if (isNaN(eventTime)) { showToast('Pick a date and time'); return; }
        const body = { title: v('efTitle').trim(), eventType: v('efType'), eventTime, durationMinutes: parseInt(v('efDuration')) || 60,
            recurrence: v('efRepeat') || null, maxGoing: parseInt(v('efCap')) || 0, description: v('efDesc').trim() || null };
        if (!e && v('efMyRole')) body.myRole = v('efMyRole');
        const res = e ? await api('PUT', `/api/teams/${currentTeamId}/events/${e.id}`, body) : await api('POST', `/api/teams/${currentTeamId}/events`, body);
        if (res.error) { showToast(res.error); return; }
        closeModal();
        showToast(e ? 'Event updated' : 'Event created');
        if (!e && res.id) expanded.add(res.id);
        await reload();
    });
    setTimeout(() => form.querySelector('#efTitle').focus(), 0);
}

function openLineupModal(e) {
    if (!e) return;
    let slots = parseLineup(e);
    if (slots.length === 0) slots = roles.map(r => ({ role: r, userId: null }));
    const members = teamData?.members || [];
    const going = new Set(rsvpsFor(e.id).filter(r => r.status === 'going').map(r => r.user_id));
    const back = modal(`
        <h2>Lineup · ${esc(e.title)}</h2>
        <p class="tf-help">Assign members to slots. Members who RSVP'd going are listed first.</p>
        <div class="e-lineup-edit" data-role="slots"></div>
        <div class="tf-actions"><button type="button" class="btn btn-sm btn-secondary" data-act="addslot">+ Slot</button><div class="header-spacer"></div>
            <button type="button" class="btn btn-secondary" data-close="1">Cancel</button><button type="button" class="btn btn-primary" data-act="save">Save lineup</button></div>`, { wide: true });
    const host = back.querySelector('[data-role="slots"]');
    const draw = () => {
        host.innerHTML = slots.map((s, i) => `
            <div class="e-slot-row">
                <input type="text" maxlength="30" value="${esc(s.role)}" data-i="${i}" data-f="role" placeholder="Role">
                <select data-i="${i}" data-f="userId">
                    <option value="">open</option>
                    ${[...members].sort((a, b) => (going.has(b.id) - going.has(a.id)) || a.username.localeCompare(b.username)).map(m => `<option value="${m.id}" ${s.userId === m.id ? 'selected' : ''}>${esc(m.username)}${going.has(m.id) ? ' ✓' : ''}</option>`).join('')}
                </select>
                <button type="button" class="tbtn-icon tbtn-icon-danger" data-act="rm" data-i="${i}" title="Remove slot">&#10005;</button>
            </div>`).join('');
    };
    draw();
    back.addEventListener('input', (ev) => { const t = ev.target; if (t.dataset.f) slots[+t.dataset.i][t.dataset.f] = t.value || null; });
    back.addEventListener('change', (ev) => { const t = ev.target; if (t.dataset.f) slots[+t.dataset.i][t.dataset.f] = t.value || null; });
    back.addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-act]'); if (!b) return;
        if (b.dataset.act === 'addslot') { slots.push({ role: '', userId: null }); draw(); }
        if (b.dataset.act === 'rm') { slots.splice(+b.dataset.i, 1); draw(); }
        if (b.dataset.act === 'save') {
            const clean = slots.filter(s => s.role && s.role.trim());
            const res = await api('PUT', `/api/teams/${currentTeamId}/events/${e.id}`, { lineup: clean.length ? clean : null });
            if (res.error) { showToast(res.error); return; }
            closeModal(); showToast('Lineup saved'); await reload();
        }
    });
}

async function openAttendanceModal(e) {
    if (!e) return;
    const data = await api('GET', `/api/teams/${currentTeamId}/events/${e.id}/attendance`);
    const marked = new Map((data.attendance || []).map(a => [a.user_id, !!a.attended]));
    const going = new Set(rsvpsFor(e.id).filter(r => r.status === 'going').map(r => r.user_id));
    const members = [...(teamData?.members || [])].sort((a, b) => (going.has(b.id) - going.has(a.id)) || a.username.localeCompare(b.username));
    const back = modal(`
        <h2>Attendance · ${esc(e.title)}</h2>
        <p class="tf-help">Tick who actually showed up. Unmarked members default to their RSVP.</p>
        <div class="e-att-list">${members.map(m => `<label class="e-att-row"><input type="checkbox" data-uid="${m.id}" ${(marked.has(m.id) ? marked.get(m.id) : going.has(m.id)) ? 'checked' : ''}><span>${esc(m.username)}</span>${going.has(m.id) ? '<span class="chip chip-success">RSVP going</span>' : ''}</label>`).join('')}</div>
        <div class="tf-actions"><button type="button" class="btn btn-secondary" data-close="1">Cancel</button><button type="button" class="btn btn-primary" data-act="save">Save attendance</button></div>`, { wide: true });
    back.addEventListener('click', async (ev) => {
        if (!ev.target.closest('[data-act="save"]')) return;
        const attendance = [...back.querySelectorAll('[data-uid]')].map(c => ({ userId: c.dataset.uid, attended: c.checked }));
        const res = await api('POST', `/api/teams/${currentTeamId}/events/${e.id}/attendance`, { attendance });
        if (res.error) { showToast(res.error); return; }
        closeModal(); showToast('Attendance saved');
    });
}

async function saveTemplate(e) {
    if (!e) return;
    const name = prompt('Template name:', e.title); if (!name) return;
    const res = await api('POST', `/api/teams/${currentTeamId}/event-templates`, { name, title: e.title, description: e.description, eventType: e.event_type, durationMinutes: e.duration_minutes, recurrence: e.recurrence });
    if (res.error) { showToast(res.error); return; }
    showToast('Template saved');
}

async function showReport() {
    const data = await api('GET', `/api/teams/${currentTeamId}/attendance-report`);
    if (data.error) { showToast(data.error); return; }
    const rows = (data.report || []).map(r => `<div class="t-row"><span>${esc(r.username)}</span><span class="t-dim">${r.attended} attended · ${r.rsvp_going} RSVP'd · ${r.total_events} events</span></div>`).join('');
    modal(`<h2>Attendance report</h2>${rows || '<div class="t-empty-sub">No data yet.</div>'}<div class="tf-actions"><button class="btn btn-secondary btn-sm" data-close="1">Close</button></div>`, { wide: true });
}

window.Events = { open, refresh: () => reload() };
