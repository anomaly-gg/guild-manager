// Roster module: Members (game role, team role, activity, notes, kick), Availability (weekly grid +
// my slots), Requests (pending join requests). ES module; uses shell globals by name. window.Roster.

import { esc } from './timer-cards.js?v=20260923e';

export const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_IDX = [1, 2, 3, 4, 5, 6, 0]; // display order → JS getDay()

let tab = 'members';
let search = '';
let slots = [];        // availability rows for the whole team
let requests = [];     // pending join requests (officers)
let refreshTimer = null;

const root = () => document.getElementById('rosterContent');
const modalHost = () => document.getElementById('deathModal');
const team = () => teamData?.team;
const members = () => teamData?.members || [];
const isLeader = () => team()?.my_role === 'leader';
const isOfficer = () => team()?.my_role === 'leader' || team()?.my_role === 'officer';
const me = () => currentUser?.id;

// ---------------------------------------------------------------- open / data

export async function open(which = 'members') {
    tab = which;
    teamTab = which;
    renderTeamView();
    await Promise.all([reloadTeam(), load()]);
    if (!['members', 'availability', 'requests'].includes(teamTab)) return;
    render();
    startLoop();
}

async function reloadTeam() {
    const data = await api('GET', `/api/teams/${currentTeamId}`);
    if (!data.error) teamData = data;
}

async function load() {
    const jobs = [api('GET', `/api/teams/${currentTeamId}/availability`).catch(() => ({}))];
    if (isOfficer()) jobs.push(api('GET', `/api/teams/${currentTeamId}/join-requests`).catch(() => ({})));
    const [a, r] = await Promise.all(jobs);
    slots = a?.slots || [];
    requests = r?.requests || [];
}

async function refresh({ team: t = true } = {}) {
    if (t) await reloadTeam();
    await load();
    if (['members', 'availability', 'requests'].includes(teamTab)) render();
}

function startLoop() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => {
        if (!['members', 'availability', 'requests'].includes(teamTab) || !root()) { clearInterval(refreshTimer); refreshTimer = null; return; }
        await refresh();
    }, 60000);
}

// ---------------------------------------------------------------- helpers

function activity(m, nowSec = Math.floor(Date.now() / 1000)) {
    if (!m.last_seen) return { key: 'never', label: 'Never seen' };
    const ago = nowSec - m.last_seen;
    if (ago < 300) return { key: 'online', label: 'Online' };
    if (ago < 3600) return { key: 'away', label: `${Math.floor(ago / 60)}m ago` };
    if (ago < 86400) return { key: 'away', label: `${Math.floor(ago / 3600)}h ago` };
    if (ago < 604800) return { key: 'off', label: `${Math.floor(ago / 86400)}d ago` };
    return { key: 'off', label: 'Inactive' };
}
function avatarHtml(m) {
    const initials = (m.username || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const src = avatarUrl(m);
    return src ? avatarImg(src, 'r-avatar', esc(initials)) : `<span class="r-avatar r-initials">${esc(initials)}</span>`;
}
function roleRank(m) { return m.role === 'leader' ? 0 : m.role === 'officer' ? 1 : 2; }
function sortedMembers() {
    const q = search.trim().toLowerCase();
    const list = members().filter(m => !q || m.username.toLowerCase().includes(q) || (m.game_role || '').toLowerCase().includes(q));
    const nowSec = Math.floor(Date.now() / 1000);
    return list.sort((a, b) => roleRank(a) - roleRank(b) || (activity(b, nowSec).key === 'online') - (activity(a, nowSec).key === 'online') || a.username.localeCompare(b.username));
}

// ---------------------------------------------------------------- render

function render() {
    const el = root();
    if (!el) return;
    if (tab === 'members') el.innerHTML = membersHtml();
    else if (tab === 'availability') el.innerHTML = availabilityHtml();
    else el.innerHTML = requestsHtml();
    el.onclick = onClick;
    el.oninput = (e) => { if (e.target.dataset.role === 'search') { search = e.target.value; const l = el.querySelector('[data-role="list"]'); if (l) l.innerHTML = memberRowsHtml(); } };
    el.onchange = onChange;
}

function membersHtml() {
    const list = members();
    const nowSec = Math.floor(Date.now() / 1000);
    const online = list.filter(m => activity(m, nowSec).key === 'online').length;
    const roleCounts = {};
    for (const m of list) if (m.game_role) roleCounts[m.game_role] = (roleCounts[m.game_role] || 0) + 1;
    const roleBits = Object.entries(roleCounts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="e-rolecount">${esc(k)} <b>${n}</b></span>`).join('');
    return `
        <div class="timers-toolbar">
            <input type="search" class="timers-search" data-role="search" placeholder="Search members or roles" value="${esc(search)}" autocomplete="off">
            <span class="invite-chip" data-action="copyinvite" title="Copy invite code">Invite <code>${esc(team().invite_code)}</code></span>
        </div>
        <div class="timers-summary"><b>${list.length}</b> of ${team().max_members || '∞'} members · <span class="${online ? 't-ok' : ''}">${online} online</span>${roleBits ? ' · ' + roleBits : ''}</div>
        <div class="rrows" data-role="list">${memberRowsHtml()}</div>`;
}

function memberRowsHtml() {
    const nowSec = Math.floor(Date.now() / 1000);
    const list = sortedMembers();
    if (!list.length) return `<div class="t-empty card"><div class="t-empty-title">No members match “${esc(search)}”</div></div>`;
    return list.map(m => {
        const a = activity(m, nowSec);
        const isMe = m.id === me();
        const canEditRole = isMe || isOfficer();
        const gameRole = m.game_role
            ? `<button class="r-gamerole ${canEditRole ? 'editable' : ''}" ${canEditRole ? `data-action="gamerole" data-id="${m.id}"` : ''} title="${canEditRole ? 'Change game role' : ''}">${esc(m.game_role)}</button>`
            : (canEditRole ? `<button class="r-gamerole r-gamerole-empty" data-action="gamerole" data-id="${m.id}">${isMe ? '+ your class / role' : '+ class / role'}</button>` : '');
        const actions = [
            isOfficer() && !isMe ? `<button class="tbtn-icon" data-action="notes" data-id="${m.id}" title="Officer notes">${ICON.note}</button>` : '',
            isLeader() && !isMe && m.role !== 'leader' ? `<select class="r-roleselect" data-role="teamrole" data-id="${m.id}" title="Team role"><option value="member" ${m.role === 'member' ? 'selected' : ''}>Member</option><option value="officer" ${m.role === 'officer' ? 'selected' : ''}>Officer</option></select>` : '',
            isOfficer() && !isMe && m.role !== 'leader' && !(m.role === 'officer' && !isLeader()) ? `<button class="tbtn-icon tbtn-icon-danger" data-action="kick" data-id="${m.id}" title="Remove from team">${ICON.x}</button>` : '',
            isMe && m.role !== 'leader' ? `<button class="btn btn-sm btn-secondary" data-action="leave">Leave team</button>` : '',
        ].filter(Boolean).join('');
        return `
            <article class="rrow" data-user-id="${m.id}">
                ${avatarHtml(m)}
                <div class="rrow-body">
                    <div class="rrow-top"><span class="rrow-name">${esc(m.username)}${isMe ? ' <span class="e-dim">(you)</span>' : ''}</span><span class="team-role ${m.role}">${m.role}</span>${m.premium ? '<span class="chip chip-warn" title="Premium">★</span>' : ''}</div>
                    <div class="rrow-meta"><span class="r-dot ${a.key}"></span>${a.label}${m.joined_at ? ` · joined ${new Date(m.joined_at * 1000).toLocaleDateString([], { month: 'short', year: 'numeric' })}` : ''}</div>
                </div>
                <div class="rrow-role">${gameRole}</div>
                <div class="rrow-actions">${actions}</div>
            </article>`;
    }).join('');
}

// --- availability
function toMin(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); }
function availabilityHtml() {
    const byUser = {};
    for (const s of slots) (byUser[s.user_id] ||= { username: s.username, slots: [] }).slots.push(s);
    const mine = slots.filter(s => s.user_id === me());
    // per day: best 1-hour block by member count
    const best = DAY_IDX.map(day => {
        const counts = new Array(24).fill(0);
        for (const s of slots) if (s.day === day) { for (let h = Math.floor(toMin(s.start_time) / 60); h < Math.ceil(toMin(s.end_time) / 60) && h < 24; h++) counts[h]++; }
        const max = Math.max(...counts); const h = counts.indexOf(max);
        return max > 0 ? { h, n: max } : null;
    });
    const total = Object.keys(byUser).length;
    const cols = DAY_IDX.map((day, i) => {
        const people = Object.values(byUser).map(u => ({ username: u.username, ranges: u.slots.filter(s => s.day === day).map(s => `${s.start_time}–${s.end_time}`) })).filter(p => p.ranges.length);
        return `<div class="av-day">
            <div class="av-head"><b>${DAY[i]}</b>${best[i] ? `<span class="av-best" title="Most members free">${String(best[i].h).padStart(2, '0')}:00 · ${best[i].n}</span>` : ''}</div>
            ${people.length ? people.map(p => `<div class="av-person"><span class="av-name">${esc(p.username)}</span><span class="av-ranges">${p.ranges.map(esc).join(', ')}</span></div>`).join('') : '<div class="av-empty">—</div>'}
        </div>`;
    }).join('');
    return `
        <div class="timers-toolbar">
            <div class="timers-summary" style="margin:0"><b>${total}</b> of ${members().length} members set their weekly availability${mine.length ? '' : ' · <span class="t-warnish">yours is not set</span>'}</div>
            <div class="header-spacer"></div>
            <button class="btn btn-primary" data-action="editavail">${mine.length ? 'Edit my availability' : '+ Set my availability'}</button>
        </div>
        <div class="av-grid">${cols}</div>
        <p class="tf-help" style="margin-top:10px">Times are in each member's own local time. The badge on each day is the hour when the most members are free.</p>`;
}

// --- requests
function requestsHtml() {
    if (!isOfficer()) return '<div class="t-empty card"><div class="t-empty-title">Officers only</div></div>';
    const approval = teamData?.settings?.inviteApproval;
    if (!requests.length) return `<div class="t-empty card"><div class="t-empty-title">No pending requests</div><div class="t-empty-sub">People who use your invite code while "Require approval to join" is on (Settings → Invites) show up here.</div></div>`;
    return `<div class="rrows">${requests.map(r => `
        <article class="rrow">
            <span class="r-avatar r-initials">${esc((r.username || '?').slice(0, 2).toUpperCase())}</span>
            <div class="rrow-body"><div class="rrow-top"><span class="rrow-name">${esc(r.username)}</span></div><div class="rrow-meta">asked ${new Date(r.created_at * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div></div>
            <div class="rrow-actions"><button class="btn btn-sm tbtn-kill" data-action="approve" data-id="${r.id}">Approve</button><button class="btn btn-sm btn-danger" data-action="deny" data-id="${r.id}">Deny</button></div>
        </article>`).join('')}</div>`;
}

export function pendingCount() { return requests.length; }

// ---------------------------------------------------------------- actions

const ICON = {
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h11l3 3v13H5z"/><path d="M8 10h8M8 14h8"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

function onClick(ev) {
    const btn = ev.target.closest('[data-action]');
    if (!btn || !root()?.contains(btn)) return;
    const id = btn.dataset.id;
    switch (btn.dataset.action) {
        case 'copyinvite': navigator.clipboard.writeText(team().invite_code); showToast('Invite code copied'); break;
        case 'gamerole': openGameRoleModal(members().find(m => m.id === id)); break;
        case 'notes': openNotesModal(members().find(m => m.id === id)); break;
        case 'kick': kick(id); break;
        case 'leave': leave(); break;
        case 'editavail': openAvailabilityModal(); break;
        case 'approve': decide(id, 'approve'); break;
        case 'deny': decide(id, 'deny'); break;
    }
}

function onChange(ev) {
    const sel = ev.target;
    if (sel.dataset.role === 'teamrole') changeRole(sel.dataset.id, sel.value);
}

const changeRole = guard('roster.role', async (userId, role) => {
    const res = await api('POST', `/api/teams/${currentTeamId}/members/role`, { userId, role });
    if (res.error) { showToast(res.error); await refresh(); return; }
    showToast('Role updated');
    await refresh();
});

const kick = guard('roster.kick', async (userId) => {
    const m = members().find(x => x.id === userId);
    if (!(await confirmDialog(`Remove ${m?.username || 'this member'} from the team?`, { confirmLabel: 'Remove' }))) return;
    const res = await api('POST', `/api/teams/${currentTeamId}/kick`, { userId });
    if (res.error) { showToast(res.error); return; }
    showToast('Member removed');
    await refresh();
});

const leave = guard('roster.leave', async () => {
    if (!(await confirmDialog(`Leave ${team().name}?`, { confirmLabel: 'Leave' }))) return;
    const res = await api('POST', `/api/teams/${currentTeamId}/leave`);
    if (res.error) { showToast(res.error); return; }
    showToast('You left the team');
    showTeamList();
});

const decide = guard('roster.request', async (reqId, action) => {
    const res = await api('POST', `/api/teams/${currentTeamId}/join-requests/${reqId}/${action}`);
    if (res.error) { showToast(res.error); }
    else showToast(res.message || 'Done');
    await refresh();
});

// ---------------------------------------------------------------- modals

function closeModal() { modalHost().innerHTML = ''; }
function modal(inner, { wide } = {}) {
    modalHost().innerHTML = `<div class="modal-backdrop" data-close="1"><div class="card modal-card ${wide ? 'modal-wide' : ''}">${inner}</div></div>`;
    const back = modalHost().firstElementChild;
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]:not(.modal-backdrop)')) closeModal(); });
    return back;
}

function openGameRoleModal(m) {
    if (!m) return;
    const back = modal(`
        <h2>${m.id === me() ? 'Your class / role' : esc(m.username) + ' · class / role'}</h2>
        <form class="tform" id="grForm">
            <label class="tf-field tf-wide"><span>Class, spec or role <em>as your game calls it</em></span><input id="grValue" maxlength="30" value="${esc(m.game_role || '')}" placeholder="e.g. Dark Knight, Healer, Archer"></label>
            <p class="tf-help tf-wide">Shown on the roster and counted in the summary. Leave empty to clear.</p>
            <div class="tf-actions tf-wide"><button type="button" class="btn btn-secondary" data-close="1">Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
        </form>`);
    const form = back.querySelector('#grForm');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const res = await api('PUT', `/api/teams/${currentTeamId}/members/${m.id}`, { gameRole: form.querySelector('#grValue').value.trim() || null });
        if (res.error) { showToast(res.error); return; }
        closeModal(); await refresh();
    });
    setTimeout(() => form.querySelector('#grValue').focus(), 0);
}

async function openNotesModal(m) {
    if (!m) return;
    const draw = async () => {
        const data = await api('GET', `/api/teams/${currentTeamId}/members/${m.id}/notes`);
        const notes = data.notes || [];
        const back = modal(`
            <h2>Notes · ${esc(m.username)}</h2>
            <p class="tf-help">Private to officers and the leader.</p>
            <div class="r-notes">${notes.length ? notes.map(n => `<div class="r-note"><div>${esc(n.note)}</div><div class="e-dim">${esc(n.author_name)} · ${new Date(n.created_at * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}${(n.author_id === me() || isLeader()) ? ` <button class="r-note-del" data-del="${n.id}">delete</button>` : ''}</div></div>`).join('') : '<div class="t-empty-sub">No notes yet.</div>'}</div>
            <form class="tform" id="noteForm"><label class="tf-field tf-wide"><span>Add a note</span><input id="noteText" maxlength="1000" placeholder="e.g. Reliable healer, prefers weekends"></label>
            <div class="tf-actions tf-wide"><button type="button" class="btn btn-secondary" data-close="1">Close</button><button type="submit" class="btn btn-primary">Add note</button></div></form>`, { wide: true });
        back.querySelector('#noteForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const note = back.querySelector('#noteText').value.trim(); if (!note) return;
            const res = await api('POST', `/api/teams/${currentTeamId}/members/${m.id}/notes`, { note });
            if (res.error) { showToast(res.error); return; }
            await draw();
        });
        back.addEventListener('click', async (e) => {
            const d = e.target.closest('[data-del]'); if (!d) return;
            await api('DELETE', `/api/teams/${currentTeamId}/notes/${d.dataset.del}`);
            await draw();
        });
    };
    await draw();
}

function openAvailabilityModal() {
    let mine = slots.filter(s => s.user_id === me()).map(s => ({ day: s.day, start: s.start_time, end: s.end_time }));
    if (!mine.length) mine = [{ day: 6, start: '20:00', end: '23:00' }];
    const back = modal(`
        <h2>My weekly availability</h2>
        <p class="tf-help">When are you usually free to play? Officers use this to pick raid times.</p>
        <div class="av-edit" data-role="rows"></div>
        <div class="tf-actions"><button type="button" class="btn btn-sm btn-secondary" data-act="add">+ Add time</button><div class="header-spacer"></div><button type="button" class="btn btn-secondary" data-close="1">Cancel</button><button type="button" class="btn btn-primary" data-act="save">Save</button></div>`);
    const host = back.querySelector('[data-role="rows"]');
    const draw = () => {
        host.innerHTML = mine.map((s, i) => `<div class="av-edit-row">
            <select data-i="${i}" data-f="day">${DAY_IDX.map((d, k) => `<option value="${d}" ${s.day === d ? 'selected' : ''}>${DAY[k]}</option>`).join('')}</select>
            <input type="time" data-i="${i}" data-f="start" value="${esc(s.start)}"><span class="tf-amp">to</span><input type="time" data-i="${i}" data-f="end" value="${esc(s.end)}">
            <button type="button" class="tbtn-icon tbtn-icon-danger" data-act="rm" data-i="${i}" title="Remove">${ICON.x}</button></div>`).join('');
    };
    draw();
    back.addEventListener('change', (ev) => { const t = ev.target; if (t.dataset.f) mine[+t.dataset.i][t.dataset.f] = t.dataset.f === 'day' ? +t.value : t.value; });
    back.addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-act]'); if (!b) return;
        if (b.dataset.act === 'add') { mine.push({ day: 6, start: '20:00', end: '23:00' }); draw(); }
        if (b.dataset.act === 'rm') { mine.splice(+b.dataset.i, 1); draw(); }
        if (b.dataset.act === 'save') {
            const clean = mine.filter(s => s.start && s.end && s.start < s.end).map(s => ({ day: s.day, startTime: s.start, endTime: s.end }));
            const res = await api('PUT', `/api/teams/${currentTeamId}/availability`, { slots: clean });
            if (res.error) { showToast(res.error); return; }
            closeModal(); showToast('Availability saved'); await refresh({ team: false });
        }
    });
}

window.Roster = { open, refresh, pendingCount };
