// Service worker: phone alerts only (no offline cache, no fetch handler).
//
// Pushes arrive EMPTY (a wake-up); this asks the worker what to show (/public/push/sync) and makes
// the screen match: ONE notification per team, updated in place. Sound only when a boss is newly
// spawning soon or up; kills and auto-resets update it silently, and it closes when nothing is left.
// What was already announced is remembered per team, so a notification the member swiped away does
// not come back ringing for the same bosses.

const API = 'https://guild-manager.xpropics.workers.dev';   // the local test harness rewrites this
const CLOSE_AFTER_MS = 4000;   // an "all clear" stays this long, then goes away
const STATE = 'https://gm-push.local/announced';   // { tag: [entry ids] } kept in Cache Storage

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => e.waitUntil(sync()));

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    e.waitUntil((async () => {
        const scope = self.registration.scope;
        const open = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).find(c => c.url.startsWith(scope));
        return open ? open.focus() : self.clients.openWindow(scope);
    })());
});

async function loadAnnounced() {
    try { const r = await (await caches.open('gm-push')).match(STATE); return r ? await r.json() : {}; } catch { return {}; }
}
async function saveAnnounced(state) {
    try { await (await caches.open('gm-push')).put(STATE, new Response(JSON.stringify(state))); } catch { /* best effort */ }
}

function show(tag, title, body, { sound = false, sticky = false } = {}) {
    return self.registration.showNotification(title, {
        tag, body, icon: 'icon-192.png',
        renotify: sound, silent: !sound,
        requireInteraction: sticky,   // desktop: stays on screen while a boss is up, until it is killed or resets
    });
}

async function sync() {
    const sub = await self.registration.pushManager.getSubscription();
    let data = { items: [] };
    try {
        const r = await fetch(API + '/public/push/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub?.endpoint || '' }) });
        data = await r.json();
    } catch { /* offline: fall through to the quiet note below */ }

    const open = new Map((await self.registration.getNotifications()).map(n => [n.tag, n]));
    const announced = await loadAnnounced();
    const closing = [];
    let shown = 0;

    if (data.test) { await show(data.test.tag, data.test.title, data.test.body, { sound: true }); shown++; }

    for (const it of data.items || []) {
        const cur = open.get(it.tag);
        const before = announced[it.tag] || [];
        const ids = it.entries.map(e => e.id);
        announced[it.tag] = ids;
        if (!ids.length) {   // killed / auto-reset / all clear: say so briefly, then go away
            if (cur) { await show(it.tag, it.title, 'Nothing up or spawning soon.'); closing.push(it.tag); shown++; }
            continue;
        }
        const fresh = it.entries.filter(e => !before.includes(e.id));
        const sticky = ids.some(id => id.endsWith(':spawned'));
        if (fresh.length) {   // something new: ring, titled with what just happened
            await show(it.tag, fresh[0].title, it.body, { sound: true, sticky });
            shown++;
        } else if (cur && (ids.length !== before.length || ids.some((id, i) => id !== before[i]))) {   // one ended: update quietly
            await show(it.tag, cur.title, it.body, { sticky });
            shown++;
        }
        // nothing new and the member swiped it away: leave it gone
    }
    await saveAnnounced(announced);

    // A push must end with a notification shown, or browsers stop delivering to the site.
    if (!shown) {
        const newest = (await self.registration.getNotifications())[0];
        if (newest) await show(newest.tag, newest.title, newest.body, { sticky: newest.requireInteraction });
        else { await show('sync', 'Guild Manager', 'Timers updated.'); closing.push('sync'); }
    }
    if (data.unknown && sub) await sub.unsubscribe().catch(() => {});   // alerts were turned off for this device
    if (closing.length) {
        await new Promise(r => setTimeout(r, CLOSE_AFTER_MS));
        for (const n of await self.registration.getNotifications()) if (closing.includes(n.tag)) n.close();
    }
}
