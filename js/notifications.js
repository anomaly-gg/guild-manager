// In-tab boss alerts (while the page is open) + Do-Not-Disturb toggle.
// Same rules as phone alerts (sw.js): ONE notification per team, updated in place; sound only when
// a boss is newly spawning soon or up; silent updates when one is killed or resets; closed when
// nothing is left. A browser with phone alerts on (js/modules/push.js) gets those instead.

let dndMode = localStorage.getItem('gm_dnd') === 'true';
const tabAlert = { tag: null, entries: [], title: '', n: null };

function requestNotifPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function phoneAlertsOn() {
    try { return localStorage.getItem('gm_push') === '1'; } catch { return false; }
}

// Called every second by the timers loop (js/timers.js) with the open team's bosses.
function syncTabAlert(teamId, teamName, bosses, now = Date.now()) {
    if (!teamId || !('Notification' in window) || Notification.permission !== 'granted') return;
    const tag = 'team-' + teamId;
    if (tabAlert.tag !== tag) { tabAlert.n?.close(); Object.assign(tabAlert, { tag, entries: [], title: '', n: null }); }   // switched team
    if (dndMode || phoneAlertsOn()) { if (tabAlert.n) { tabAlert.n.close(); tabAlert.n = null; tabAlert.entries = []; } return; }

    const entries = [];
    for (const b of bosses) {
        const remaining = b.next_spawn - now;
        if (remaining <= 0 || b.status === 'spawned') {
            entries.push({ id: b.id + ':spawned', title: `🔴 ${b.name} is up`, line: `🔴 ${b.name}${b.location ? ' · ' + b.location : ''}` });
        } else if (remaining <= (b.alert_minutes || 5) * 60000) {
            const min = Math.max(1, Math.round(remaining / 60000));
            entries.push({ id: b.id + ':soon', title: `⏳ ${b.name} spawns in ${min} min`, line: `⏳ ${b.name}${b.location ? ' · ' + b.location : ''}` });
        }
    }
    const ids = entries.map(e => e.id);
    const fresh = entries.filter(e => !tabAlert.entries.includes(e.id));
    if (!fresh.length && ids.length === tabAlert.entries.length) return;   // nothing changed
    tabAlert.entries = ids;
    if (!ids.length) { tabAlert.n?.close(); tabAlert.n = null; return; }   // killed / reset: gone

    if (fresh.length) tabAlert.title = `${fresh[0].title} · ${teamName}`;
    const body = entries.slice(0, 6).map(e => e.line).join('\n') + (entries.length > 6 ? `\n+${entries.length - 6} more` : '');
    try {
        const n = new Notification(tabAlert.title || teamName, {
            tag, body, icon: 'icon-192.png',
            renotify: fresh.length > 0, silent: !fresh.length,
            requireInteraction: ids.some(id => id.endsWith(':spawned')),   // stays while a boss is up
        });
        n.onclick = () => { window.focus(); n.close(); };
        tabAlert.n = n;
    } catch { /* some browsers only allow notifications from a service worker */ }
}

function toggleDND() {
    dndMode = !dndMode;
    localStorage.setItem('gm_dnd', dndMode);
    updateDNDBadge();
}

function updateDNDBadge() {
    const el = document.getElementById('dndBtn');
    if (el) {
        el.textContent = dndMode ? '🔕 DND On' : '🔔 Alerts On';
        el.style.background = dndMode ? '#7f1d1d' : '#16653466';
        el.style.color = dndMode ? '#fca5a5' : '#4ade80';
    }
}

requestNotifPermission();
