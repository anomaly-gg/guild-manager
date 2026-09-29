// Timers → a boss's group chip (officers): which spawn group takes the next spawn, the 2nd and the
// 3rd, plus "Alternate groups" (after a spawn ends with no pick for the next one, the next group in
// the team's list takes it). Saves through PUT /bosses/:id/group. ES module; uses shell globals by
// name (api, showToast, guard, currentTeamId, teamSpawnGroups, teamTimeStr, teamTz).

import { esc } from './timer-cards.js?v=20260929d';

const SLOTS = ['Next spawn', '2nd spawn', '3rd spawn'];
const host = () => document.getElementById('deathModal');

const parseLater = (raw) => { try { const a = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(a) ? a : []; } catch { return []; } };

// Rough time of the k-th coming spawn, for the labels: respawn-after-kill bosses only (the others
// follow their calendar and the Timers page already shows the next one).
function estimate(boss, k) {
    const at = k === 0 ? boss.next_spawn : boss.type === 'interval' && boss.interval_ms ? boss.next_spawn + k * boss.interval_ms : null;
    if (at == null) return '';
    const day = new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: teamTz() });
    return `${k ? '~' : ''}${teamTimeStr(at)} · ${day}`;
}

export function open(boss, { onSaved } = {}) {
    const groups = teamSpawnGroups || [];
    if (!groups.length) { showToast('Add spawn groups first: Settings → Daily schedule post'); return; }
    const picks = [boss.spawn_group || '', ...parseLater(boss.later_groups).map(x => x || '')];
    const select = (k) => `<label class="tf-field"><span>${SLOTS[k]} <em>${esc(estimate(boss, k))}</em></span>
        <select data-slot="${k}"><option value="">No group</option>${groups.map(g => `<option value="${esc(g.id)}" ${picks[k] === g.id ? 'selected' : ''}>@${esc(g.name)}</option>`).join('')}</select></label>`;
    host().innerHTML = `
        <div class="modal-backdrop">
            <div class="card modal-card">
                <h2>Groups for ${esc(boss.name)}</h2>
                <form class="tform" id="sgForm">
                    ${select(0)}${select(1)}${select(2)}
                    <label class="s-toggle tf-wide"><input type="checkbox" id="sgAlt" ${boss.alternate_groups ? 'checked' : ''}><span>Alternate groups<small>When a spawn ends and nobody picked a group for the next one, it goes to the next group that takes turns (${esc(groups.filter(g => g.rotation !== false).map(g => g.name).join(' → ') || 'none yet')} → …).</small></span></label>
                    <p class="tf-help tf-wide">Each pick belongs to that spawn: when it is killed or auto-resets, the 2nd becomes the next, and so on.</p>
                    <div class="tf-actions tf-wide">
                        <button type="button" class="btn btn-secondary" data-close="1">Cancel</button>
                        <button type="submit" class="btn btn-primary">Save</button>
                    </div>
                </form>
            </div>
        </div>`;
    const back = host().firstElementChild;
    const close = () => { host().innerHTML = ''; };
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) close(); });
    back.querySelector('#sgForm').addEventListener('submit', guard('timers.groups', async (e) => {
        e.preventDefault();
        const list = [0, 1, 2].map(k => back.querySelector(`[data-slot="${k}"]`).value || null);
        const alternate = back.querySelector('#sgAlt').checked;
        const res = await api('PUT', `/api/teams/${currentTeamId}/bosses/${boss.id}/group`, { groups: list, alternate });
        if (res.error) { showToast(res.error); return; }
        boss.spawn_group = list[0];
        while (list.length > 1 && !list[list.length - 1]) list.pop();
        boss.later_groups = list.length > 1 ? JSON.stringify(list.slice(1)) : null;
        boss.alternate_groups = alternate ? 1 : 0;
        close();
        showToast(`Groups saved for ${boss.name}`);
        onSaved?.();
    }));
}
