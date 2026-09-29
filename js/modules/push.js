// Phone alerts (M14 web push): this device on/off, per-team choices, test. Account menu →
// "Phone alerts". The device side lives in sw.js; the worker side in routes/push.js.
// ES module; uses shell globals by name (api, API, showToast, escapeHtml, currentUser).

const FLAG = 'gm_push';   // this browser has alerts on (so the in-tab alerts step aside, js/notifications.js)
const host = () => document.getElementById('deathModal');

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// 'ok' | 'ios-install' | 'unsupported' | 'denied'
export function support() {
    if (isIos() && !isStandalone()) return 'ios-install';
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    return 'ok';
}

function keyBytes(b64) {
    const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4));
    return Uint8Array.from(s, c => c.charCodeAt(0));
}

async function currentSub() {
    if (!('serviceWorker' in navigator)) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
}

async function turnOn() {
    if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications were not allowed. Allow them for this site in the browser, then try again.');
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const { key, error } = await api('GET', '/api/push/key');
    if (error) throw new Error(error);
    const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    const res = await api('POST', '/api/push/subscribe', { endpoint: sub.endpoint });
    if (res.error) throw new Error(res.error);
    try { localStorage.setItem(FLAG, '1'); } catch { /* private mode: in-tab alerts may double up */ }
}

async function turnOff() {
    const sub = await currentSub();
    if (sub) {
        await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
        await sub.unsubscribe().catch(() => {});
    }
    try { localStorage.removeItem(FLAG); } catch { /* nothing kept */ }
}

// After sign-in: re-register this device for whoever is signed in now (a shared device moves to them).
export async function resume() {
    try {
        if (localStorage.getItem(FLAG) !== '1' || support() !== 'ok' || Notification.permission !== 'granted') return;
        const sub = await currentSub();
        if (!sub) { localStorage.removeItem(FLAG); return; }
        await api('POST', '/api/push/subscribe', { endpoint: sub.endpoint });
    } catch { /* next sign-in tries again */ }
}

// On log out, before the token is dropped: this device stops alerting for that account.
export async function forget(tok) {
    try {
        const sub = await currentSub();
        if (sub) {
            await fetch(API + '/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ endpoint: sub.endpoint }) });
            await sub.unsubscribe();
        }
        localStorage.removeItem(FLAG);
    } catch { /* the worker drops dead devices by itself */ }
}

// ---------------------------------------------------------------- dialog

const DEVICE_NOTES = {
    'ios-install': 'On iPhone and iPad, alerts only work from the Home Screen app: tap <b>Share</b> → <b>Add to Home Screen</b>, open Guild Manager from there, then turn alerts on here.',
    unsupported: 'This browser cannot show alerts. Use Chrome or Edge on Android or a computer, or Safari on iPhone from the Home Screen.',
    denied: 'Notifications are blocked for this site. Allow them in the browser\'s site settings (the icon left of the address), then reopen this.',
};

function deviceHtml(state, on) {
    if (state !== 'ok') return `<div class="pa-device pa-device-off"><p>${DEVICE_NOTES[state]}</p></div>`;
    return on
        ? `<div class="pa-device pa-device-on"><p><b>On</b> for this device.</p><div class="pa-actions"><button class="btn btn-secondary btn-sm" data-act="test">Send a test</button><button class="btn btn-secondary btn-sm" data-act="off">Turn off</button></div></div>`
        : `<div class="pa-device pa-device-off"><p><b>Off</b> for this device.</p><div class="pa-actions"><button class="btn btn-primary btn-sm" data-act="on">Turn on alerts</button></div></div>`;
}

function teamHtml(t, noGroup) {
    const follows = (id) => !t.groups || t.groups.includes(id);
    const groups = t.groupList.length ? `
        <div class="pa-groups"><span class="pa-label">Spawn groups</span>
            ${[...t.groupList, { id: noGroup, name: 'No group' }].map(g => `<label class="pa-chip"><input type="checkbox" data-role="group" value="${escapeHtml(g.id)}" ${follows(g.id) ? 'checked' : ''}><span>${escapeHtml(g.name)}</span></label>`).join('')}
        </div>` : '';
    return `
        <div class="pa-team" data-team="${escapeHtml(t.id)}">
            <div class="pa-team-name">${escapeHtml(t.name)}</div>
            <div class="pa-kinds">
                <label><input type="checkbox" data-role="soon" ${t.soon ? 'checked' : ''}> Spawning soon</label>
                <label><input type="checkbox" data-role="spawned" ${t.spawned ? 'checked' : ''}> Spawned</label>
            </div>${groups}
        </div>`;
}

export async function open() {
    host().innerHTML = `
        <div class="modal-backdrop">
            <div class="card modal-card pa-card">
                <div class="help-head"><h2>Phone alerts</h2><button class="tbtn-icon" data-close title="Close">&#10005;</button></div>
                <p class="tf-help">A notification on this device when a boss is about to spawn or is up, even with the app closed. One notification per team, updated as bosses spawn and die, so it never floods your phone.</p>
                <div data-role="device"><div class="spinner"></div></div>
                <h3 class="t-h3">What to alert</h3>
                <div data-role="teams"></div>
            </div>
        </div>`;
    const back = host().firstElementChild;
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) host().innerHTML = ''; });

    let state = support(), prefs = null, sub = null;
    const render = async () => {
        sub = state === 'ok' ? await currentSub() : null;
        prefs = await api('GET', '/api/push/prefs' + (sub ? '?endpoint=' + encodeURIComponent(sub.endpoint) : ''));
        if (prefs.error) { back.querySelector('[data-role="teams"]').innerHTML = `<p class="tf-help">${escapeHtml(prefs.error)}</p>`; return; }
        back.querySelector('[data-role="device"]').innerHTML = deviceHtml(state, !!sub && prefs.device);
        back.querySelector('[data-role="teams"]').innerHTML = prefs.teams.length
            ? prefs.teams.map(t => teamHtml(t, prefs.noGroup)).join('') + (prefs.devices > 1 ? `<p class="tf-help">Alerts are on for ${prefs.devices} devices on your account; these choices apply to all of them.</p>` : '')
            : '<p class="tf-help">Join or create a team first.</p>';
    };

    back.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        const btn = e.target.closest('button'); if (btn) btn.disabled = true;
        try {
            if (act === 'on') { await turnOn(); showToast('Alerts are on for this device'); }
            if (act === 'off') { await turnOff(); showToast('Alerts are off for this device'); }
            if (act === 'test') {
                const r = await api('POST', '/api/push/test', { endpoint: sub?.endpoint });
                showToast(r.error || 'Test sent. It should appear in a few seconds.');
            }
        } catch (err) {
            showToast(err.message || 'Could not change alerts on this device');
        }
        if (btn) btn.disabled = false;
        state = support();
        if (act !== 'test') await render();
    });

    back.addEventListener('change', async (e) => {
        const card = e.target.closest('[data-team]');
        if (!card) return;
        const checked = [...card.querySelectorAll('[data-role="group"]')];
        const groups = checked.length ? checked.filter(c => c.checked).map(c => c.value) : null;
        const res = await api('PUT', '/api/push/prefs', {
            teamId: card.dataset.team,
            soon: card.querySelector('[data-role="soon"]').checked,
            spawned: card.querySelector('[data-role="spawned"]').checked,
            groups,
        });
        showToast(res.error || 'Saved');
    });

    await render();
}
