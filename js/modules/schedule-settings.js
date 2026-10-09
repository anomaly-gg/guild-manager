// Settings → "Daily schedule post" card: the schedule channels (webhook-list.js; their buttons are
// handled by settings.js) and the spawn groups officers hand spawns to. Rendered by settings.js
// (cardHtml) and wired here (mount); saves go through the settings PUT that settings.js passes in.
// ES module; uses shell globals by name (api, showToast).

import { esc } from './timer-cards.js?v=20260929a';
import * as Webhooks from './webhook-list.js?v=20261009b';

const MAX_GROUPS = 8;
let roleServers = null;   // [{ guildId, name, roles: [{ id, name, color }] }] from linked servers, loaded once per open
let linked = [];          // [{ guildId, name }] linked servers from settings: the pickers shown before roles load

const servers = () => roleServers || linked.map(s => ({ guildId: s.guildId, name: s.name, roles: null }));
const serverNames = (settings) => Object.fromEntries((settings.discordGuilds || []).map(g => [g.guildId, g.name || 'Server ' + g.guildId]));

export function cardHtml(settings, max) {
    linked = settings.discordGuilds || [];
    return `<section class="card s-card" id="sScheduleCard"><h3>Daily schedule post</h3>
        <p class="s-desc">Posts the day's boss schedule to a Discord channel at 00:00 team time and keeps that one message up to date: a spawn is crossed out when it is killed or auto-resets, and restarted timers appear as new lines. Use its own channel so the post stays easy to find.</p>
        ${Webhooks.html('schedule', settings.webhooks?.schedule || [], { label: 'Schedule channels', max, upsell: true, servers: serverNames(settings) })}
        <div class="t-h3">Spawn groups</div>
        <p class="s-desc">The alliance guilds or parties you hand spawns to. Assign a spawn on the Timers page or with <code>/assign</code> in Discord; the post and <code>/next</code> show it at the end of the line. Pick a Discord role to show it as that role's coloured tag (nobody gets pinged); with several servers linked, pick the group's role in each, since every channel shows the roles of its own server. Untick <b>Takes turns</b> for a group like "ALL" that bosses set to alternate should never land on.</p>
        <div class="sg-list" data-role="sg-list">${(settings.spawnGroups || []).map(rowHtml).join('')}</div>
        <div class="tf-actions" style="justify-content:flex-start">
            <button class="btn btn-secondary btn-sm" data-sched="add-group">+ Add group</button>
            <button class="btn btn-primary btn-sm" data-sched="save-groups">Save groups</button>
        </div>
    </section>`;
}

// One picker per linked server: role ids belong to one server, so a group can be @Viserion in one
// and @VIS in another. g.roles = { guildId: roleId }; g.roleId = a role saved before roles were per
// server, shown under whichever server has it.
function rolesHtml(g = {}) {
    const list = servers();
    if (!list.length) return '<select class="sg-role" disabled title="Link a Discord server (Discord slash commands card) to tag groups with its roles"><option>No Discord server linked</option></select>';
    return list.map(s => {
        const known = s.roles || [];
        const selected = g.roles?.[s.guildId] || (g.roleId && known.some(r => r.id === g.roleId) ? g.roleId : '');
        // Keep a saved role selectable before the list loads (or if the bot left that server).
        const keep = selected && !known.some(r => r.id === selected) ? `<option value="${esc(selected)}" selected>${s.roles ? 'Role not found in this server' : 'Saved role'}</option>` : '';
        // With several servers a picked role also names its server, so the closed picker still says which.
        const server = esc(s.name || 'server ' + s.guildId), where = list.length > 1 ? ` · ${server}` : '';
        const none = list.length > 1 ? `No role in ${server}` : 'No Discord role';
        return `<select class="sg-role" data-guild="${esc(s.guildId)}" title="${esc(s.name || '')}"><option value="">${none}</option>${keep}${
            known.map(r => `<option value="${r.id}" ${r.id === selected ? 'selected' : ''}>@${esc(r.name)}${where}</option>`).join('')}</select>`;
    }).join('');
}

function rowHtml(g = {}) {
    return `<div class="sg-row" data-id="${esc(g.id || '')}" data-legacy="${esc(g.roleId || '')}">
        <input type="text" class="sg-name" maxlength="30" placeholder="Group name, e.g. Kongreso" value="${esc(g.name || '')}">
        <div class="sg-roles">${rolesHtml(g)}</div>
        <label class="sg-turns" title="Takes a turn when bosses alternate groups"><input type="checkbox" class="sg-rotation" ${g.rotation === false ? '' : 'checked'}> Takes turns</label>
        <button class="tbtn-icon tbtn-icon-danger" data-sched="remove-group" title="Remove group" aria-label="Remove group">&times;</button>
    </div>`;
}

// The roles picked in a row; an old-style role that no picker shows yet is kept as it was.
function readRoles(row) {
    const roles = {};
    row.querySelectorAll('.sg-role[data-guild]').forEach(sel => { if (sel.value) roles[sel.dataset.guild] = sel.value; });
    const legacy = row.dataset.legacy;
    const shown = legacy && [...row.querySelectorAll('.sg-role option')].some(o => o.value === legacy);
    return { roles, roleId: legacy && !shown ? legacy : null };
}

function readGroups(card) {
    return [...card.querySelectorAll('.sg-row')].map(row => ({
        id: row.dataset.id || undefined,
        name: row.querySelector('.sg-name').value.trim(),
        ...readRoles(row),
        rotation: row.querySelector('.sg-rotation').checked,
    })).filter(g => g.name);
}

// Load each linked server's roles, then redraw the pickers keeping what is picked. If Discord does
// not answer, the saved roles stay as they are.
async function loadRoles(card, settings) {
    if (roleServers || !(settings.discordGuilds || []).length) return;
    const d = await api('GET', `/api/teams/${currentTeamId}/discord-roles`).catch(() => null);
    if (!d?.servers) return;
    roleServers = d.servers;
    card.querySelectorAll('.sg-row').forEach(row => { row.querySelector('.sg-roles').innerHTML = rolesHtml(readRoles(row)); });
}

// put(body, okMsg) -> bool and reload() come from settings.js.
export function mount(card, settings, { put, reload }) {
    if (!card) return;
    roleServers = null;
    loadRoles(card, settings);
    const list = card.querySelector('[data-role="sg-list"]');
    card.addEventListener('change', (e) => {
        const sel = e.target.closest('.sg-role');
        if (!sel) return;
        const name = sel.closest('.sg-row').querySelector('.sg-name');
        if (!name.value.trim() && sel.value) name.value = sel.selectedOptions[0].textContent.replace(/^@/, '').replace(/ · .*$/, '').slice(0, 30);
    });
    card.addEventListener('click', guard('settings.schedule', async (e) => {
        const btn = e.target.closest('[data-sched]');
        if (!btn) return;
        switch (btn.dataset.sched) {
            case 'add-group':
                if (list.querySelectorAll('.sg-row').length >= MAX_GROUPS) { showToast(`Up to ${MAX_GROUPS} groups`); return; }
                list.insertAdjacentHTML('beforeend', rowHtml());
                list.lastElementChild.querySelector('.sg-name').focus();
                break;
            case 'remove-group': btn.closest('.sg-row').remove(); break;
            case 'save-groups':
                if (await put({ spawnGroups: readGroups(card) }, 'Spawn groups saved')) await reload();
                break;
        }
    }));
}
