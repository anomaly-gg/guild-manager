// Generic helpers: escapeHtml, formatTime, formatTimeLong, showToast, copyInvite, goHome, avatarUrl, timezone display

// Modal backdrops close on a click OUTSIDE the card. A drag that starts inside the card (selecting
// text in a field) and ends on the backdrop also fires a 'click' on the backdrop; swallow those so
// every module's "click backdrop = close" handler only sees real outside clicks.
(function() {
    let pressedOnBackdrop = false;
    document.addEventListener('pointerdown', (e) => { pressedOnBackdrop = e.target.classList?.contains('modal-backdrop'); }, true);
    document.addEventListener('click', (e) => {
        if (e.target.classList?.contains('modal-backdrop') && !pressedOnBackdrop) e.stopPropagation();
    }, true);
})();

// --- Timezone display (per device, localStorage 'gm_tz_mode': 'device' | 'team') ---
// Every stored time is absolute (ms). Boss schedules (weekly/daily) are written in the TEAM timezone
// (Settings → Team); everything else is shown in the viewer's device timezone unless they choose
// "team time" in Account & data. Helpers are globals so ES modules can use them too.
function deviceTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } }
function teamTz() { return teamData?.timezone || 'Asia/Manila'; }
function tzMode() { try { return localStorage.getItem('gm_tz_mode') === 'team' ? 'team' : 'device'; } catch { return 'device'; } }
function setTzMode(mode) { try { localStorage.setItem('gm_tz_mode', mode === 'team' ? 'team' : 'device'); } catch {} }
function validTz(tz) { try { new Intl.DateTimeFormat([], { timeZone: tz }); return true; } catch { return false; } }
// The IANA zone times are DISPLAYED in, or undefined for the device zone.
function displayTz() { const tz = teamTz(); return tzMode() === 'team' && validTz(tz) ? tz : undefined; }
// Spread into any toLocale*String options.
function tzOpts(opts) { const tz = displayTz(); return tz ? { ...opts, timeZone: tz } : opts; }
// True when the device clock differs from the team's zone (hints become useful).
function tzDiffers() { const tz = teamTz(); if (!validTz(tz)) return false; return offsetMinutes(tz) !== offsetMinutes(deviceTz()); }
function offsetMinutes(tz, at = new Date()) {
    at = new Date(Math.floor(at.getTime() / 60000) * 60000);   // whole minutes, so the parts below round-trip exactly
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
    const g = (t) => Number(p.find(x => x.type === t)?.value);
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'));
    return Math.round((asUtc - at.getTime()) / 60000);
}
// "3 h ahead of you" / "6 h behind you" for the team zone vs the device.
function tzOffsetLabel() {
    const diff = offsetMinutes(teamTz()) - offsetMinutes(deviceTz());
    if (!diff) return 'same as your device';
    const h = Math.abs(diff) / 60;
    return `${Number.isInteger(h) ? h : h.toFixed(1)} h ${diff > 0 ? 'ahead of' : 'behind'} your device`;
}
// A clock time in the team zone, e.g. "21:00", for "team time" suffixes.
function teamTimeStr(ms) { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: teamTz() }); }

// Image URL for a user row ({ avatar, discord_id }) or the session user ({ avatar, discordId }), else null.
// Google accounts store a full picture URL; Discord accounts store an avatar hash for the CDN.
function avatarUrl(u) {
    const avatar = u?.avatar || '';
    const id = u?.discord_id || u?.discordId || '';
    if (/^https?:\/\//.test(avatar)) return avatar;
    if (avatar && /^\d+$/.test(id)) return `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=64`;
    return null;
}
// <img> that swaps itself for an initials badge if the picture fails to load.
function avatarImg(src, cls, initials) {
    return `<img class="${cls}" src="${src}" alt="${initials}" onerror="this.replaceWith(Object.assign(document.createElement('span'), { className: '${cls} r-initials', textContent: this.alt }))">`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTimeLong(ms) {
    const totalMin = Math.floor(ms / 60000);
    if (totalMin < 60) return totalMin + 'min';
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h < 24) return h + 'h ' + (m > 0 ? m + 'm' : '');
    const d = Math.floor(h / 24);
    return d + 'd ' + (h % 24) + 'h';
}

function formatTime(ms) {
    if (ms <= 0) return '00:00';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
}

// Tick — update countdown text + desktop notifications

function copyInvite(code) {
    navigator.clipboard.writeText(code);
    showToast('Invite code copied!');
}

function goHome() {
    if (currentUser) showTeamList();
    else showLogin();
}

function showToast(message) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// Promise-based replacement for window.confirm: the app's own modal (native confirm blocks the
// whole tab and looks foreign). Backdrop click and Escape cancel. Global so ES modules see it.
function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = true } = {}) {
    return new Promise((resolve) => {
        const host = document.createElement('div');
        host.innerHTML = `<div class="modal-backdrop" style="z-index:300"><div class="card modal-card">
            <h2>${escapeHtml(title)}</h2>
            <p class="confirm-msg">${escapeHtml(message)}</p>
            <div class="tf-actions">
                <button type="button" class="btn btn-secondary" data-c="0">Cancel</button>
                <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-c="1">${escapeHtml(confirmLabel)}</button>
            </div></div></div>`;
        const done = (v) => { host.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
        host.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal-backdrop')) return done(false);
            const b = e.target.closest('[data-c]');
            if (b) done(b.dataset.c === '1');
        });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(host);
        host.querySelector('[data-c="1"]').focus();
    });
}

// Collapsible card sections (used by several tabs)
function toggleSection(id, el) {
    document.getElementById(id).classList.toggle('open');
    el.querySelector('.toggle-arrow').classList.toggle('open');
}

// Close any open <details class="menu"> dropdown when clicking elsewhere or pressing Escape.
document.addEventListener('click', (e) => {
    document.querySelectorAll('details.menu[open]').forEach(m => { if (!m.contains(e.target)) m.open = false; });
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('details.menu[open]').forEach(m => { m.open = false; });
});
