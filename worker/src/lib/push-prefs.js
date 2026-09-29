// Phone-alert choices, one row per member per team (push_prefs). No row = the defaults: spawning
// soon + spawned, every group. `groups` = the spawn groups this member follows (team group ids,
// plus NO_GROUP for bosses nobody was assigned); null = all of them.

export const NO_GROUP = 'none';

export function prefOf(row) {
  let groups = null;
  try { const g = row?.groups ? JSON.parse(row.groups) : null; groups = Array.isArray(g) ? g : null; } catch { /* default: all */ }
  return { soon: row?.soon == null ? true : !!row.soon, spawned: row?.spawned == null ? true : !!row.spawned, groups };
}

const followsGroup = (pref, groupId) => !pref.groups || pref.groups.includes(groupId || NO_GROUP);

// Does this member want a phone alert for this kind of change?
//   soon / spawned: their own switch + the boss's group
//   ended (killed / auto-reset): only if they got a bubble for that spawn, which then goes away
//   maintenance: one alert for the whole reset, whatever the groups
export function wants(pref, kind, groupId) {
  if (kind === 'maintenance') return pref.soon || pref.spawned;
  if (kind === 'soon' && !pref.soon) return false;
  if (kind === 'spawned' && !pref.spawned) return false;
  if (kind === 'ended' && !pref.soon && !pref.spawned) return false;
  return followsGroup(pref, groupId);
}

// PUT body -> row values, or an error string. `groupIds` = the team's current group ids.
export function cleanPrefs(body, groupIds) {
  const out = { soon: body?.soon === false ? 0 : 1, spawned: body?.spawned === false ? 0 : 1, groups: null };
  if (Array.isArray(body?.groups)) {
    const allowed = new Set([...groupIds, NO_GROUP]);
    const picked = [...new Set(body.groups.map(String))];
    if (picked.some(g => !allowed.has(g))) return 'Unknown group';
    // every group picked = "all", so groups added later are followed too
    out.groups = allowed.size === picked.length ? null : JSON.stringify(picked);
  }
  return out;
}
