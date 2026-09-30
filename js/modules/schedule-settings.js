// Settings → "Daily schedule post" card: the schedule channels (webhook-list.js; their buttons are
// handled by settings.js) and the spawn groups officers hand spawns to. Rendered by settings.js
// (cardHtml) and wired here (mount); saves go through the settings PUT that settings.js passes in.
// ES module; uses shell globals by name (api, showToast).

import { esc } from './timer-cards.js?v=20260929a';
import * as Webhooks from './webhook-list.js?v=20260930b';

const MAX_GROUPS = 8;
let roleServers = null;   // [{ guildId, name, roles: [{ id, name, color }] }] from linked servers, loaded once per open

export function cardHtml(settings, max) {
    return `<section class="card s-card" id="sScheduleCard"><h3>Daily schedule post</h3>
        <p class="s-desc">Posts the day's boss schedule to a Discord channel at 00:00 team time and keeps that one message up to date: a spawn is crossed out when it is killed or auto-resets, and restarted timers appear as new lines. Use its own channel so the post stays easy to find.</p>
        ${Webhooks.html('schedule', settings.webhooks?.schedule || [], { label: 'Schedule channels', max, upsell: true })}
        <div class="t-h3">Spawn groups</div>
        <p class="s-desc">The alliance guilds or parties you hand spawns to. Assign a spawn on the Timers page or with <code>/assign</code> in Discord; the post and <code>/next</code> show it at the end of the line. Pick a Discord role to show it as that role's coloured tag (nobody gets pinged). Untick <b>Takes turns</b> for a group like "ALL" that bosses set to alternate should never land on.</p>
        <div class="sg-list" data-role="sg-list">${(settings.spawnGroups || []).map(rowHtml).join('')}</div>
        <div class="tf-actions" style="justify-content:flex-start">
            <button class="btn btn-secondary btn-sm" data-sched="add-group">+ Add group</button>
            <button class="btn btn-primary btn-sm" data-sched="save-groups">Save groups</button>
        </div>
    </section>`;
}

function roleOptions(selected) {
    const servers = roleServers || [];
    const known = servers.some(s => s.roles.some(r => r.id === selected));
    const opts = servers.filter(s => s.roles.length).map(s => `<optgroup label="${esc(s.name || 'Server ' + s.guildId)}">${
        s.roles.map(r => `<option value="${r.id}" ${r.id === selected ? 'selected' : ''}>@${esc(r.name)}</option>`).join('')}</optgroup>`).join('');
    // Keep a saved role selectable even before the list loads (or if the bot left that server).
    const keep = selected && !known ? `<option value="${esc(selected)}" selected>${roleServers ? 'Role not found in linked servers' : 'Saved role'}</option>` : '';
    return `<option value="">No Discord role</option>${keep}${opts}`;
}

function rowHtml(g = {}) {
    return `<div class="sg-row" data-id="${esc(g.id || '')}">
        <input type="text" class="sg-name" maxlength="30" placeholder="Group name, e.g. Kongreso" value="${esc(g.name || '')}">
        <select class="sg-role" data-role-id="${esc(g.roleId || '')}">${roleOptions(g.roleId || '')}</select>
        <label class="sg-turns" title="Takes a turn when bosses alternate groups"><input type="checkbox" class="sg-rotation" ${g.rotation === false ? '' : 'checked'}> Takes turns</label>
        <button class="tbtn-icon tbtn-icon-danger" data-sched="remove-group" title="Remove group" aria-label="Remove group">&times;</button>
    </div>`;
}

function readGroups(card) {
    return [...card.querySelectorAll('.sg-row')].map(row => ({
        id: row.dataset.id || undefined,
        name: row.querySelector('.sg-name').value.trim(),
        roleId: row.querySelector('.sg-role').value || null,
        rotation: row.querySelector('.sg-rotation').checked,
    })).filter(g => g.name);
}

async function loadRoles(card, settings) {
    if (roleServers || !(settings.discordGuilds || []).length) return;
    const d = await api('GET', `/api/teams/${currentTeamId}/discord-roles`).catch(() => null);
    roleServers = d?.servers || [];
    card.querySelectorAll('.sg-role').forEach(sel => { sel.innerHTML = roleOptions(sel.dataset.roleId); });
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
        sel.dataset.roleId = sel.value;
        const name = sel.closest('.sg-row').querySelector('.sg-name');
        if (!name.value.trim() && sel.value) name.value = sel.selectedOptions[0].textContent.replace(/^@/, '').slice(0, 30);
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
