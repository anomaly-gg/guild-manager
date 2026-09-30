// Discord channels of one alert kind (url = main alerts, boss, events, schedule), for Settings →
// Discord alerts and Daily schedule post: the saved channels by webhook name, each with Test and
// Remove, plus a box to paste another while under the plan's limit. Buttons carry data-action
// wh-add / wh-test / wh-remove; settings.js routes them to act(). ES module; uses shell globals by
// name (api, showToast, currentTeamId).

import { esc } from './timer-cards.js?v=20260929a';

const EMPTY = { url: 'No channel yet: nothing is posted to Discord', boss: 'None: boss alerts go to the main channels', events: 'None: event alerts go to the main channels', schedule: 'No channel yet' };
const REMOVE = {
    url: (last) => last ? 'Remove this channel? Discord alerts stop until you add one again.' : 'Remove this channel? The other channels keep getting alerts.',
    boss: (last) => last ? 'Remove this channel? Boss alerts go back to the main channels.' : 'Remove this channel? The other boss channels keep getting alerts.',
    events: (last) => last ? 'Remove this channel? Event alerts go back to the main channels.' : 'Remove this channel? The other event channels keep getting alerts.',
    schedule: (last) => `Stop the schedule post in this channel? Its messages stay in Discord but stop updating.${last ? '' : ' The other channels keep theirs.'}`,
};

// hooks = [{ id, name }] from GET settings; max = channels allowed on this plan
export function html(kind, hooks, { label, max, upsell }) {
    const rows = hooks.length
        ? hooks.map(h => `<div class="t-row t-row-sm wh-row"><span>${esc(h.name || 'Webhook')} <span class="t-dim">#${esc(h.id.slice(-4))}</span></span>
            <span class="wh-actions"><button class="btn btn-sm btn-secondary" data-action="wh-test" data-kind="${kind}" data-id="${esc(h.id)}">Test</button><button class="btn btn-sm btn-secondary" data-action="wh-remove" data-kind="${kind}" data-id="${esc(h.id)}" data-last="${hooks.length === 1 ? 1 : ''}">Remove</button></span></div>`).join('')
        : `<div class="t-row t-row-sm"><span class="t-dim">${EMPTY[kind]}</span></div>`;
    const add = hooks.length < max
        ? `<div class="s-inline wh-add"><input type="url" id="wh-${kind}" placeholder="${hooks.length ? "Another channel's webhook URL" : 'https://discord.com/api/webhooks/...'}" autocomplete="off"><button class="btn btn-sm btn-primary" data-action="wh-add" data-kind="${kind}">${hooks.length ? 'Add channel' : 'Save'}</button></div>`
        : upsell && max < 2 ? `<div class="s-inline wh-limit"><span class="t-dim">Posting to more than one channel is Premium.</span><button class="btn btn-sm btn-secondary" data-action="upgrade">Upgrade</button></div>` : '';
    return `<div class="wh-list"><div class="wh-label">${label} <span class="t-dim">${hooks.length}/${max}</span></div>${rows}${add}</div>`;
}

const T = () => currentTeamId;
const ADDED = { schedule: "Channel added. Today's schedule is being posted there." };

// -> true when the list changed (the caller reloads)
export async function act(action, btn, root) {
    const { kind, id } = btn.dataset;
    if (action === 'wh-add') {
        const input = root.querySelector('#wh-' + kind);
        const url = input?.value.trim();
        if (!url) { showToast('Paste a webhook URL first'); return false; }
        btn.disabled = true;
        const r = await api('POST', `/api/teams/${T()}/webhooks`, { kind, url });
        btn.disabled = false;
        if (r.error) { if (r.premiumRequired) showUpgradeModal(); else showToast(r.error); return false; }
        showToast(ADDED[kind] || `Channel added${r.name ? ': ' + r.name : ''}`);
        return true;
    }
    if (action === 'wh-test') {
        const r = await api('POST', `/api/teams/${T()}/webhooks/${kind}/${id}/test`);
        showToast(r.ok ? 'Test sent to Discord' : r.error || 'Failed');
        return false;
    }
    if (action === 'wh-remove') {
        if (!confirm(REMOVE[kind](!!btn.dataset.last))) return false;
        const r = await api('DELETE', `/api/teams/${T()}/webhooks/${kind}/${id}`);
        if (r.error) { showToast(r.error); return false; }
        showToast('Channel removed');
        return true;
    }
    return false;
}
