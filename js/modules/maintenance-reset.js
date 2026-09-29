// Timers → "Maintenance reset": after server maintenance every respawn-timer boss spawns when the
// server opens, so all interval timers move to that time in one go (worker
// routes/maintenance-reset.js). Fixed-schedule bosses keep their times. ES module; uses shell
// globals by name (api, showToast, currentTeamId, teamBosses).

const HOUR = 3600000;
const host = () => document.getElementById('deathModal');
const pad = (n) => String(n).padStart(2, '0');
// datetime-local value in this device's time, like the "Set kill time" dialog
const localValue = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function open({ onDone } = {}) {
    const reset = teamBosses.filter(b => b.type === 'interval').length;
    const kept = teamBosses.length - reset;
    if (!reset) { showToast('No respawn-timer bosses to reset. Fixed-schedule bosses keep their times.'); return; }
    const now = Date.now();
    host().innerHTML = `
        <div class="modal-backdrop" data-close="1">
            <div class="card modal-card">
                <h2>Maintenance reset</h2>
                <p class="tf-help">After maintenance every respawn-timer boss spawns when the server opens. This sets all <b>${reset}</b> of them to spawn at the time below.${kept ? ` The <b>${kept}</b> fixed-schedule boss${kept === 1 ? '' : 'es'} keep${kept === 1 ? 's' : ''} ${kept === 1 ? 'its' : 'their'} time.` : ''}</p>
                <form class="tform" data-role="form">
                    <label class="tf-field tf-wide"><span>Server opens at</span><input data-role="when" type="datetime-local" value="${localValue(now)}" min="${localValue(now - 12 * HOUR)}" max="${localValue(now + 24 * HOUR)}" required></label>
                    <p class="tf-help tf-wide">Discord gets one message for the reset instead of a ping per boss. Bosses nobody kills auto-reset as usual.</p>
                    <div class="tf-actions tf-wide">
                        <button type="button" class="btn btn-secondary" data-act="close">Cancel</button>
                        <button type="submit" class="btn btn-primary" data-act="apply">Reset ${reset} timer${reset === 1 ? '' : 's'}</button>
                    </div>
                </form>
            </div>
        </div>`;
    const back = host().firstElementChild;
    const close = () => { host().innerHTML = ''; };
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-act="close"]')) close(); });
    back.querySelector('[data-role="form"]').addEventListener('submit', async (e) => {
        e.preventDefault();
        const openAt = new Date(back.querySelector('[data-role="when"]').value).getTime();
        if (isNaN(openAt)) { showToast('Pick a valid time'); return; }
        const btn = back.querySelector('[data-act="apply"]');
        btn.disabled = true;
        const res = await api('POST', `/api/teams/${currentTeamId}/bosses/maintenance-reset`, { openAt });
        btn.disabled = false;
        if (res.error) { showToast(res.error); return; }
        close();
        showToast(`${res.reset} timer${res.reset === 1 ? '' : 's'} reset to ${new Date(res.openAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
        onDone?.();
    });
}
