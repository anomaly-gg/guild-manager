// Timers → "Maintenance reset": the officer gives the maintenance window (from - to = server open).
// Every respawn-timer boss spawns when the server opens, and so does a fixed-schedule boss that was
// due inside the window; the rest keep their times (worker lib/maintenance.js). The summary under
// the times is the worker's own answer (preview), so what it lists is what the reset does.
// ES module; uses shell globals by name (api, showToast, currentTeamId).

const HOUR = 3600000;
const host = () => document.getElementById('deathModal');
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// date / time input values in this device's time, like the "Set kill time" dialog
const dayValue = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const timeValue = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Last reset's times of day on today's date; the first time, the 5 hours up to now.
function defaults(last) {
    const now = Date.now();
    if (last?.from && last?.at) return { day: dayValue(now), from: timeValue(last.from), to: timeValue(last.at) };
    const to = now - now % (5 * 60000);
    // Day = the day maintenance started (just after midnight that is yesterday).
    return { day: dayValue(to - 5 * HOUR), from: timeValue(to - 5 * HOUR), to: timeValue(to) };
}

// -> { from, openAt } in ms; a "to" at or before "from" is the next day (maintenance over midnight)
function windowOf(form) {
    const day = form.querySelector('[data-role="day"]').value;
    const from = new Date(`${day}T${form.querySelector('[data-role="from"]').value}`).getTime();
    let openAt = new Date(`${day}T${form.querySelector('[data-role="to"]').value}`).getTime();
    if (openAt <= from) openAt += 24 * HOUR;
    return { from, openAt };
}

function summaryHtml(p) {
    const lines = [`<b>${plural(p.reset, 'respawn timer', 'respawn timers')}</b> go${p.reset === 1 ? 'es' : ''} up at ${clock(p.openAt)}.`];
    if (p.fixed.length) lines.push(`Due during maintenance, up at open too: <b>${p.fixed.map(esc).join(', ')}</b>.`);
    if (p.killed.length) lines.push(`Killed since the server opened, left alone: ${p.killed.map(esc).join(', ')}.`);
    if (p.kept) lines.push(`${plural(p.kept, 'fixed-schedule boss keeps its', 'fixed-schedule bosses keep their')} time.`);
    return lines.map(l => `<div>${l}</div>`).join('');
}

export async function open({ onDone } = {}) {
    const data = await api('GET', `/api/teams/${currentTeamId}/bosses`);
    if (data.error) { showToast(data.error); return; }
    if (!(data.bosses || []).length) { showToast('No bosses to reset yet.'); return; }
    const d = defaults(data.maintenance);
    host().innerHTML = `
        <div class="modal-backdrop" data-close="1">
            <div class="card modal-card">
                <h2>Maintenance reset</h2>
                <p class="tf-help">When the server opens, every respawn-timer boss spawns, and so does a fixed-schedule boss that was due while the server was down. Give the maintenance window and they all go up at the end of it.</p>
                <form class="tform" data-role="form">
                    <label class="tf-field tf-wide"><span>Day</span><input data-role="day" type="date" value="${d.day}" required></label>
                    <label class="tf-field"><span>Maintenance from</span><input data-role="from" type="time" value="${d.from}" required></label>
                    <label class="tf-field"><span>Server opens</span><input data-role="to" type="time" value="${d.to}" required></label>
                    <div class="tf-wide mr-summary" data-role="mr-summary" aria-live="polite">Checking…</div>
                    <p class="tf-help tf-wide">Discord gets one message for the reset instead of a ping per boss. Bosses nobody kills wait 30 minutes before they auto-reset.</p>
                    <div class="tf-actions tf-wide">
                        <button type="button" class="btn btn-secondary" data-act="close">Cancel</button>
                        <button type="submit" class="btn btn-primary" data-act="apply" disabled>Reset</button>
                    </div>
                </form>
            </div>
        </div>`;
    const back = host().firstElementChild;
    const form = back.querySelector('[data-role="form"]');
    const summary = back.querySelector('[data-role="mr-summary"]');
    const btn = back.querySelector('[data-act="apply"]');
    const close = () => { host().innerHTML = ''; };
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-act="close"]')) close(); });

    // Live summary: ask the worker what this window would do (latest answer wins).
    let seq = 0, timer = null;
    const preview = async () => {
        const mine = ++seq, w = windowOf(form);
        if (isNaN(w.from) || isNaN(w.openAt)) { summary.textContent = 'Pick a day and both times.'; btn.disabled = true; return; }
        const p = await api('POST', `/api/teams/${currentTeamId}/bosses/maintenance-reset`, { ...w, preview: true });
        if (mine !== seq || !summary.isConnected) return;
        if (p.error) { summary.textContent = p.error; btn.disabled = true; return; }
        const n = p.reset + p.fixed.length;
        summary.innerHTML = summaryHtml(p);
        btn.textContent = `Reset ${plural(n, 'timer', 'timers')}`;
        btn.disabled = n === 0;
    };
    form.addEventListener('input', () => { clearTimeout(timer); btn.disabled = true; timer = setTimeout(preview, 250); });
    preview();

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const w = windowOf(form);
        btn.disabled = true;
        const res = await api('POST', `/api/teams/${currentTeamId}/bosses/maintenance-reset`, w);
        btn.disabled = false;
        if (res.error) { showToast(res.error); return; }
        close();
        showToast(`${plural(res.reset + res.fixed.length, 'timer', 'timers')} reset to ${clock(res.openAt)}`);
        onDone?.();
    });
}
