// Settings module: team info, invites, modules + loot mode, Discord alerts, schedule post (schedule-settings.js), events, points,
// public timer page, team icon, leadership. ES module; uses shell globals by name. window.Settings.
// Only fields the worker actually consumes are shown here — if a setting has no consumer, it is cut.

import { esc } from './timer-cards.js?v=20260923e';
import * as ScheduleCard from './schedule-settings.js?v=20260930c';
import * as Webhooks from './webhook-list.js?v=20260930c';

const TIMEZONES = ['Asia/Manila', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Australia/Sydney', 'Pacific/Auckland'];

let settings = null;

const root = () => document.getElementById('settingsContent');
const team = () => teamData?.team;
const T = () => currentTeamId;
const isLeader = () => team()?.my_role === 'leader';
const canManage = () => isLeader() || team()?.my_role === 'officer';
const isPremium = () => !!team()?.premium_team;
const $ = (id) => root()?.querySelector('#' + id);
const val = (id) => $(id)?.value ?? '';
const on = (id) => !!$(id)?.checked;

// ---------------------------------------------------------------- open / data

export async function open() {
    teamTab = 'settings';
    renderTeamView();
    await load();
    if (teamTab !== 'settings') return;
    render();
}

async function load() {
    settings = await api('GET', `/api/teams/${T()}/settings`);
    _pointsName = settings.pointsName || 'DKP';
}

async function reload() { await load(); if (teamTab === 'settings') render(); }

// ---------------------------------------------------------------- render

function render() {
    const el = root();
    if (!el) return;
    el.innerHTML = canManage()
        ? `<div class="settings">${teamCard()}${invitesCard()}${modulesCard()}${discordCard()}${ScheduleCard.cardHtml(settings, team()?.limits?.webhooks || 1)}${slashCard()}${attendanceCard()}${eventsCard()}${team()?.loot_mode === 'dkp' ? pointsCard() : ''}${publicCard()}${iconCard()}${leadershipCard()}</div>`
        : `<div class="settings"><section class="card s-card"><h3>Settings</h3><p class="s-desc">Only officers and the leader can change team settings. Ask them if something needs adjusting.</p></section>${leaveCard()}</div>`;
    el.onclick = onClick;
    el.onchange = onChange;
    if (canManage()) ScheduleCard.mount($('sScheduleCard'), settings, { put, reload });
}

const toggle = (id, label, checked, { auto, help, disabled } = {}) => `
    <label class="s-toggle ${disabled ? 'disabled' : ''}"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} ${auto ? `data-auto="${auto}"` : ''}><span>${label}${help ? `<small>${help}</small>` : ''}</span></label>`;
const gate = (inner, what) => isPremium() ? inner : `<div class="s-gate"><div class="s-gate-body">${inner}</div><div class="s-gate-bar"><span>${what} is a Premium feature.</span><button class="btn btn-sm btn-primary" data-action="upgrade">Upgrade</button></div></div>`;

function teamCard() {
    return `<section class="card s-card"><h3>Team</h3><p class="s-desc">The description shows on the team list. The timezone is used for Discord alerts and the calendar feed.</p>
        <div class="tform">
            <label class="tf-field tf-wide"><span>Description</span><textarea id="sDesc" rows="2" maxlength="200" placeholder="What is this team about?">${esc(settings.teamDescription || '')}</textarea></label>
            <label class="tf-field"><span>Timezone</span><select id="sTz">${TIMEZONES.map(tz => `<option value="${tz}" ${settings.timezone === tz ? 'selected' : ''}>${tz}</option>`).join('')}</select></label>
            <div class="tf-actions tf-wide"><button class="btn btn-primary btn-sm" data-action="save-team">Save</button></div>
        </div></section>`;
}

function invitesCard() {
    const dis = !isLeader();
    return `<section class="card s-card"><h3>Invites</h3><p class="s-desc">Anyone with the invite code from the team bar can join.${dis ? ' Only the leader can change these.' : ''}</p>
        <div class="s-toggles">
            ${toggle('sInvites', 'Accept new members', settings.invitesEnabled !== false, { auto: 'invites', disabled: dis, help: 'Turn off to freeze the roster; the code stops working.' })}
            ${toggle('sApproval', 'Require approval to join', !!settings.inviteApproval, { auto: 'invites', disabled: dis, help: 'Joins become requests that officers review under Roster → Requests.' })}
        </div></section>`;
}

function modulesCard() {
    return `<section class="card s-card"><h3>Modules</h3><p class="s-desc">Timers, Events and Roster are always on. Turn on the extras your guild actually uses.</p>
        <div class="s-toggles">${toggle('sModPoints', 'Loot &amp; Points', team()?.modules?.points !== false, { auto: 'modules', help: 'Loot log plus a rotation or a points ledger. Wishlist and auctions with Premium.' })}</div>
        <div class="loot-mode">
            <div class="loot-mode-title">Loot mode</div>
            <label class="loot-mode-opt"><input type="radio" name="sLootMode" value="rotation" ${settings.lootMode !== 'dkp' ? 'checked' : ''} data-auto="lootmode"><span><b>Rotation</b> <span class="chip chip-success">Simple</span><br>An ordered list. Whoever is on top gets the next drop, then moves to the bottom. Officers can nudge people for attendance.</span></label>
            <label class="loot-mode-opt"><input type="radio" name="sLootMode" value="dkp" ${settings.lootMode === 'dkp' ? 'checked' : ''} data-auto="lootmode"><span><b>Points (${esc(ptsName())})</b><br>Members earn points for attendance and kills and spend them on drops. Supports auctions and decay (Premium).</span></label>
        </div></section>`;
}

function slashCard() {
    const guilds = settings.discordGuilds || [];
    const rows = guilds.length
        ? guilds.map(g => `<div class="t-row t-row-sm"><span>${esc(g.name || 'Server ' + g.guildId)}</span><button class="btn btn-sm btn-secondary" data-action="discord-unlink" data-guild="${esc(g.guildId)}">Unlink</button></div>`).join('')
        : '<div class="t-row t-row-sm"><span class="t-dim">No Discord server linked yet</span></div>';
    return `<section class="card s-card"><h3>Discord slash commands</h3>
        <p class="s-desc">Use the timers from inside Discord: <code>/next</code> shows the coming spawns to anyone in your server, <code>/killed</code> lets team members log a kill. Link as many servers as you like; each server belongs to one team.</p>
        <div class="s-steps">${rows}</div>
        <div class="tf-actions" style="justify-content:flex-start">
            <button class="btn btn-primary btn-sm" data-action="discord-add">${guilds.length ? 'Add another server' : 'Add to Discord'}</button>
        </div>
        <div class="t-h3">Keep channels clean</div>
        <div class="s-toggles">${toggle('sAutoDel', 'Delete command replies after a while', settings.discordAutoDelete !== false, { help: 'Mistakes and "not allowed" replies are always shown only to the person who typed the command.' })}</div>
        <div class="tform" style="margin-top:10px">
            <label class="tf-field"><span>/killed, /assign, /rollcall <em>minutes</em></span><input type="number" id="sDelAction" min="1" max="14" value="${settings.discordDeleteActionMin ?? 1}"></label>
            <label class="tf-field"><span>/next <em>minutes</em></span><input type="number" id="sDelNext" min="1" max="14" value="${settings.discordDeleteNextMin ?? 5}"></label>
            <div class="tf-actions tf-wide"><button class="btn btn-primary btn-sm" data-action="save-autodelete">Save</button></div>
        </div>
        <p class="tf-help" style="margin-top:8px">Discord asks which server to add it to and sends you straight back here, linked. Prefer to do it by hand? Run <code>/link ${esc(team()?.invite_code || '<invite code>')}</code> in your server (leader or officer, signed in here with Discord).</p>
    </section>`;
}

function discordCard() {
    const hooks = settings.webhooks || {};
    const max = team()?.limits?.webhooks || 1;
    const servers = Object.fromEntries((settings.discordGuilds || []).map(g => [g.guildId, g.name || 'Server ' + g.guildId]));
    const list = (kind, label, opts = {}) => Webhooks.html(kind, hooks[kind] || [], { label, max, servers, ...opts });
    return `<section class="card s-card"><h3>Discord alerts</h3><p class="s-desc">Create a webhook in each Discord channel that should get alerts (Channel settings → Integrations → Webhooks) and paste it here.${max > 1 ? ` Every alert is posted in each channel of its list, up to ${max}.` : ''}</p>
        ${list('url', 'Alert channels', { upsell: true })}
        <div class="t-h3">Send alerts for</div>
        <div class="s-toggles s-toggles-row">
            ${toggle('sOnWarning', 'Boss warning', settings.onWarning !== false, { auto: 'notif' })}
            ${toggle('sOnSpawn', 'Boss spawn', settings.onSpawn !== false, { auto: 'notif' })}
            ${toggle('sOnEvent', 'Events', settings.onEvent !== false, { auto: 'notif' })}
            ${toggle('sOnLoot', 'Loot', settings.onLoot !== false, { auto: 'notif' })}
        </div>
        <div class="tform" style="margin-top:10px">
            <label class="tf-field"><span>Event reminder <em>minutes before</em></span><input type="number" id="sReminder" min="1" max="120" value="${settings.eventReminderMinutes || 15}"></label>
            <div class="tf-actions"><button class="btn btn-secondary btn-sm" data-action="save-notif">Save</button></div>
        </div>
        <div class="t-h3">Separate boss and event channels <span class="chip chip-accent">Premium</span></div>
        ${gate(`${list('boss', 'Boss alerts')}${list('events', 'Event alerts')}`, 'Sending boss and event alerts to their own channels')}
    </section>`;
}

function attendanceCard() {
    return `<section class="card s-card"><h3>Rally attendance</h3>
        <p class="s-desc">Members check in from Discord with <code>/here</code> + a screenshot; officers log a whole rally with <code>/rollcall</code>. Review under Events → Attendance. Approved rallies award points to the team ledger.</p>
        <div class="tform" style="margin-bottom:12px">
            <label class="tf-field"><span>Points per boss attended</span><input type="number" id="sAttPts" min="0" max="100" value="${settings.attendancePoints ?? 1}"></label>
        </div>
        <div class="s-toggles">
            ${toggle('sAttSelf', 'Members can check in themselves (/here with a screenshot)', settings.attendanceSelfCheckin !== false, { help: 'Off = officer roll call only, nothing to verify.' })}
            ${toggle('sAttAuto', 'Trust mode: approve unflagged check-ins automatically', !!settings.attendanceAutoApprove, { help: 'Flagged ones (no kill logged, sent hours late, duplicate screenshot) always wait for review.' })}
        </div>
        <div class="tf-actions"><button class="btn btn-primary btn-sm" data-action="save-attendance">Save</button></div>
    </section>`;
}

function eventsCard() {
    return `<section class="card s-card"><h3>Events</h3>
        <div class="s-toggles">${toggle('sMembersCreate', 'Members can create events', settings.membersCreateEvents !== false, { auto: 'events', help: 'Off means only officers and the leader post events.' })}</div>
        <div class="tform" style="margin-top:12px">
            <label class="tf-field tf-wide"><span>RSVP roles <em>comma-separated, up to 8</em></span><input type="text" id="sRsvp" maxlength="200" value="${esc((settings.rsvpRoles || ['Tank', 'Healer', 'DPS', 'Support']).join(', '))}"></label>
            <label class="tf-field"><span>Delete past events after <em>days, 0 = keep</em></span><input type="number" id="sAutoDelete" min="0" max="365" value="${settings.autoDeleteEventsDays || 0}"></label>
            <div class="tf-actions"><button class="btn btn-primary btn-sm" data-action="save-events">Save</button></div>
        </div></section>`;
}

function pointsCard() {
    return `<section class="card s-card"><h3>${esc(ptsName())} points</h3>
        <div class="tform">
            <label class="tf-field"><span>Points name</span><input type="text" id="sPtsName" maxlength="20" value="${esc(settings.pointsName || 'DKP')}" placeholder="DKP, Credits, Rep"></label>
            <div class="tf-actions"><button class="btn btn-primary btn-sm" data-action="save-points">Save</button></div>
        </div>
        <div class="t-h3">Decay <span class="chip chip-accent">Premium</span></div>
        ${gate(`<div class="s-toggles">${toggle('sDecay', `Reduce ${esc(ptsName())} for inactive members`, !!settings.dkpDecayEnabled, { help: 'Keeps the board honest when people stop showing up.' })}</div>
            <div class="tform" style="margin-top:10px">
                <label class="tf-field"><span>Decay <em>% per cycle</em></span><input type="number" id="sDecayPct" min="1" max="50" value="${settings.dkpDecayPercent || 10}"></label>
                <label class="tf-field"><span>Inactive after <em>days</em></span><input type="number" id="sDecayInactive" min="1" value="${settings.dkpDecayInactiveDays || 14}"></label>
                <label class="tf-field"><span>Run every <em>days</em></span><input type="number" id="sDecayEvery" min="1" value="${settings.dkpDecayIntervalDays || 7}"></label>
                <div class="tf-actions"><button class="btn btn-primary btn-sm" data-action="save-decay">Save</button></div>
            </div>`, 'Point decay')}
    </section>`;
}

function publicCard() {
    const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}timers.html?t=${settings.publicToken}`;
    return `<section class="card s-card"><h3>Public timer page <span class="chip chip-accent">Premium</span></h3><p class="s-desc">A read-only page of your boss timers that anyone with the link can open. Pin it in Discord.</p>
        <div class="s-toggles">${toggle('sPublic', 'Enable the public page', !!settings.publicToken, { auto: 'public', disabled: !isPremium() })}</div>
        ${settings.publicToken ? `<div class="s-inline" style="margin-top:10px"><code class="s-link" id="sPublicUrl">${esc(url)}</code><button class="btn btn-sm btn-secondary" data-action="copy-public">Copy link</button><a class="btn btn-sm btn-secondary" href="timers.html?t=${settings.publicToken}" target="_blank" rel="noopener">Open</a></div>` : ''}
        ${isPremium() ? '' : '<div class="s-gate-bar"><span>Available on Premium.</span><button class="btn btn-sm btn-primary" data-action="upgrade">Upgrade</button></div>'}
    </section>`;
}

function iconCard() {
    return `<section class="card s-card"><h3>Team icon <span class="chip chip-accent">Premium</span></h3><p class="s-desc">A small image shown next to the team name on the team list. Under 50 KB.</p>
        ${gate(`<div class="s-inline">
            <img class="s-icon-preview" id="sIconPreview" ${settings.teamIcon ? `src="${settings.teamIcon}"` : 'style="display:none"'} alt="">
            <input type="file" id="sIconFile" accept="image/*">
            <button class="btn btn-primary btn-sm" data-action="save-icon">Save</button>
            ${settings.teamIcon ? '<button class="btn btn-secondary btn-sm" data-action="remove-icon">Remove</button>' : ''}
        </div>`, 'A custom team icon')}
    </section>`;
}

function leadershipCard() {
    if (!isLeader()) return leaveCard();
    const others = (teamData?.members || []).filter(m => m.id !== currentUser?.id);
    return `<section class="card s-card s-warn"><h3>Transfer leadership</h3><p class="s-desc">Hand the team to another member. You become an officer.</p>
        <div class="s-inline">
            <select id="sTransfer" class="s-select" ${others.length ? '' : 'disabled'}>${others.length ? others.map(m => `<option value="${m.id}">${esc(m.username)}</option>`).join('') : '<option>No other members yet</option>'}</select>
            <button class="btn btn-secondary btn-sm" data-action="transfer" ${others.length ? '' : 'disabled'}>Transfer</button>
        </div></section>
        <section class="card s-card s-danger"><h3>Delete team</h3><p class="s-desc">Removes the team, its timers, events, roster data and loot history for everyone. This cannot be undone.</p>
        <button class="btn btn-danger btn-sm" data-action="delete">Delete this team</button></section>`;
}

function leaveCard() {
    return `<section class="card s-card s-danger"><h3>Leave team</h3><p class="s-desc">You can rejoin later with an invite code.</p><button class="btn btn-danger btn-sm" data-action="leave">Leave team</button></section>`;
}

// ---------------------------------------------------------------- actions

async function put(body, okMsg) {
    const res = await api('PUT', `/api/teams/${T()}/settings`, body);
    if (res.error) { showToast(res.error); await reload(); return false; }
    if (okMsg) showToast(okMsg);
    return true;
}

function onChange(ev) {
    const input = ev.target.closest('[data-auto]');
    if (!input) { if (ev.target.id === 'sIconFile') previewIcon(ev.target); return; }
    autoSave(input.dataset.auto, input);
}

const autoSave = guard('settings.auto', async (section, input) => {
    switch (section) {
        case 'invites': await put({ invitesEnabled: on('sInvites'), inviteApproval: on('sApproval') }, 'Invite settings saved'); break;
        case 'modules': {
            const points = on('sModPoints');
            if (await put({ modules: { points } }, points ? 'Loot & Points enabled' : 'Loot & Points hidden')) { if (team()) team().modules = { ...(team().modules || {}), points }; }
            break;
        }
        case 'lootmode': {
            const mode = input.value;
            if (await put({ lootMode: mode }, mode === 'dkp' ? `Loot mode: ${ptsName()} points` : 'Loot mode: rotation')) { if (team()) team().loot_mode = mode; settings.lootMode = mode; render(); }
            break;
        }
        case 'notif': await put({ onWarning: on('sOnWarning'), onSpawn: on('sOnSpawn'), onEvent: on('sOnEvent'), onLoot: on('sOnLoot') }, 'Alert settings saved'); break;
        case 'events': await put({ membersCreateEvents: on('sMembersCreate') }, 'Event settings saved'); break;
        case 'public': {
            const enable = on('sPublic');
            if (await put({ publicTimers: enable }, enable ? 'Public timer page enabled' : 'Public timer page disabled')) await reload();
            break;
        }
    }
});

function onClick(ev) {
    const btn = ev.target.closest('[data-action]');
    if (!btn || !root()?.contains(btn)) return;
    const a = btn.dataset.action;
    if (a === 'upgrade') { showUpgradeModal(); return; }
    if (a === 'copy-public') { navigator.clipboard.writeText($('sPublicUrl')?.textContent || ''); showToast('Link copied'); return; }
    act(a, btn);
}

const act = guard('settings.act', async (a, btn) => {
    switch (a) {
        case 'save-team': await put({ teamDescription: val('sDesc').trim(), timezone: val('sTz') }, 'Team saved'); break;
        case 'wh-add': case 'wh-test': case 'wh-remove': if (await Webhooks.act(a, btn, root())) await reload(); break;
        case 'discord-add': { const d = await api('GET', `/api/teams/${T()}/discord-link`); if (d.error) { showToast(d.error); break; } window.location.href = d.url; break; }
        case 'discord-unlink': if (confirm('Unlink this Discord server? Slash commands stop working there until it is linked again.')) { if (await put({ unlinkDiscordGuild: btn.dataset.guild }, 'Server unlinked')) await reload(); } break;
        case 'save-notif': await put({ onWarning: on('sOnWarning'), onSpawn: on('sOnSpawn'), onEvent: on('sOnEvent'), onLoot: on('sOnLoot'), eventReminderMinutes: Math.min(120, Math.max(1, parseInt(val('sReminder')) || 15)) }, 'Alert settings saved'); break;
        case 'save-autodelete': await put({ discordAutoDelete: on('sAutoDel'), discordDeleteActionMin: Math.max(1, Math.min(14, parseInt(val('sDelAction')) || 1)), discordDeleteNextMin: Math.max(1, Math.min(14, parseInt(val('sDelNext')) || 5)) }, 'Reply clean-up saved'); break;
        case 'save-attendance': await put({ attendancePoints: Math.max(0, Math.min(100, parseInt(val('sAttPts')) || 0)), attendanceSelfCheckin: on('sAttSelf'), attendanceAutoApprove: on('sAttAuto') }, 'Attendance settings saved'); break;
        case 'save-events': {
            const list = val('sRsvp').split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
            if (await put({ rsvpRoles: list, autoDeleteEventsDays: Math.max(0, parseInt(val('sAutoDelete')) || 0) }, 'Event settings saved')) await reload();
            break;
        }
        case 'save-points': { const name = (val('sPtsName').trim() || 'DKP').slice(0, 20); if (await put({ pointsName: name }, 'Points name saved')) { _pointsName = name; await reload(); } break; }
        case 'save-decay': await put({ dkpDecayEnabled: on('sDecay'), dkpDecayPercent: parseInt(val('sDecayPct')) || 10, dkpDecayInactiveDays: parseInt(val('sDecayInactive')) || 14, dkpDecayIntervalDays: parseInt(val('sDecayEvery')) || 7 }, 'Decay settings saved'); break;
        case 'save-icon': {
            const src = $('sIconPreview')?.src || '';
            if (!src.startsWith('data:')) { showToast('Choose an image first'); return; }
            if (await put({ teamIcon: src }, 'Team icon saved')) { _invalidateForMutation('/api/teams'); await reload(); }
            break;
        }
        case 'remove-icon': if (confirm('Remove the team icon?')) { if (await put({ teamIcon: '' }, 'Team icon removed')) { _invalidateForMutation('/api/teams'); await reload(); } } break;
        case 'transfer': {
            const sel = $('sTransfer'); const name = sel?.selectedOptions[0]?.text;
            if (!sel?.value || !confirm(`Transfer leadership to ${name}? You become an officer.`)) return;
            const r = await api('POST', `/api/teams/${T()}/transfer`, { userId: sel.value });
            if (r.error) { showToast(r.error); return; }
            showToast('Leadership transferred'); openTeam(T());
            break;
        }
        case 'delete': deleteTeam(T()); break;
        case 'leave': leaveTeam(T()); break;
    }
});

function previewIcon(input) {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 50000) { showToast('Image must be under 50 KB'); input.value = ''; return; }
    const reader = new FileReader();
    reader.onload = (e) => { const img = $('sIconPreview'); if (img) { img.src = e.target.result; img.style.display = ''; } };
    reader.readAsDataURL(file);
}

window.Settings = { open, refresh: reload };
