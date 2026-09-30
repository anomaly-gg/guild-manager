// api(): fetch wrapper with bearer token and the in-memory GET TTL cache

// --- API ---

// In-memory GET cache. Returns cached data within TTL on tab-switch /
// back-navigation. Mutations invalidate by resource bucket. Cleared
// on logout / token change so user A never sees user B's data.
const _apiCache = new Map();
const _resourceWords = ['bosses','events','announcements','wars','loot','dkp','polls','availability','performance','recruitment','files','matches','settings','chat','analytics','wishlist','join-requests','members','rosters','transfer'];
const _ttlRules = [
    { match: /\/chat(\?|$)/, ttl: 0 },
    { match: /\/rotation(\?|$)/, ttl: 0 },   // order changes on every loot write; always fresh
    { match: /\/bosses(\?|$)/, ttl: 0 },     // kills arrive from Discord and other members; the 15 s Timers loop must see them
    { match: /\/analytics/, ttl: 30000 },
    { match: /\/settings(\?|$)/, ttl: 300000 },
    { match: /\/auth\/me/, ttl: 300000 },
    { match: /\/api\/teams\/[^/?]+(\?|$)/, ttl: 300000 },
    { match: /\/api\/teams(\?|$)/, ttl: 300000 },
];
const _defaultTtl = 60000;
function _ttlFor(path) {
    for (const r of _ttlRules) if (r.match.test(path)) return r.ttl;
    return _defaultTtl;
}
function _bucketFor(path) {
    const noQuery = path.split('?')[0];
    const parts = noQuery.split('/');
    for (let i = 0; i < parts.length; i++) {
        if (_resourceWords.includes(parts[i])) {
            return parts.slice(0, i + 1).join('/');
        }
    }
    return noQuery;
}
function _invalidateForMutation(path) {
    const bucket = _bucketFor(path);
    for (const k of [..._apiCache.keys()]) {
        if (k === bucket || k.startsWith(bucket + '/') || k.startsWith(bucket + '?')) {
            _apiCache.delete(k);
        }
    }
    // The team detail (/api/teams/<id>) carries members + roles, modules, plan and timezone, so any
    // change inside a team can make it stale (a role change used to snap back until a reload).
    const team = /^\/api\/teams\/[^/?]+/.exec(path.split('?')[0]);
    if (team) _apiCache.delete(team[0]);
}
function _clearApiCache() { _apiCache.clear(); }

async function api(method, path, body) {
    if (method === 'GET') {
        const ttl = _ttlFor(path);
        if (ttl > 0) {
            const cached = _apiCache.get(path);
            if (cached && (Date.now() - cached.t) < ttl) {
                return cached.v;
            }
        }
    }
    try {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (token) opts.headers['Authorization'] = `Bearer ${token}`;
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(API + path, opts);
        const data = await res.json();
        if (method === 'GET' && _ttlFor(path) > 0 && !data.error) {
            _apiCache.set(path, { t: Date.now(), v: data });
        } else if (method !== 'GET') {
            _invalidateForMutation(path);
        }
        return data;
    } catch (e) {
        console.error('API error:', path, e);
        return { error: 'Network error' };
    }
}
