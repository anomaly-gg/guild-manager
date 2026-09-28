// Spawn groups: the alliance guilds / parties an officer hands spawns to (2-8 per team).
// Stored as JSON on team_settings.spawn_groups: [{ id, name, roleId? }].
// Per boss, groups are kept per SPAWN: bosses.spawn_group = the next spawn, bosses.later_groups =
// JSON list for the spawns after it (2nd, 3rd, ...). When a spawn ends its group moves to the
// schedule_spawns row and the list moves up (advanceGroups). bosses.alternate_groups = when nobody
// picked a group for the next spawn, take the group after the one that just ended.

export const MAX_GROUPS = 8;

export function parseGroups(raw) {
  try { const g = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(g) ? g : []; } catch { return []; }
}

// Settings input -> stored list (or an error string). Ids are kept so assignments survive renames.
export function cleanGroups(list) {
  if (!Array.isArray(list)) return 'spawnGroups must be a list';
  const out = [];
  for (const g of list.slice(0, MAX_GROUPS)) {
    const name = String(g?.name || '').trim().replace(/^@/, '').slice(0, 30);
    if (!name) continue;
    const id = /^[a-z0-9]{4,12}$/.test(g?.id || '') ? g.id : crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const roleId = /^\d{5,25}$/.test(String(g?.roleId || '')) ? String(g.roleId) : null;
    if (out.some(x => x.name.toLowerCase() === name.toLowerCase())) return `Two groups are called "${name}"`;
    out.push({ id, name, roleId });
  }
  return out;
}

// A Discord role renders as its coloured @mention (never pings: allowed_mentions is always empty);
// a group without a role shows as plain @Name.
export function groupTag(groups, groupId) {
  if (!groupId) return '';
  const g = groups.find(x => x.id === groupId);
  if (!g) return '';
  return g.roleId ? `<@&${g.roleId}>` : `@${g.name}`;
}

export const MAX_LATER = 3;

export function parseLater(raw) {
  try { const a = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(a) ? a.map(x => x || null) : []; } catch { return []; }
}

// The group after `groupId` in the team's list (wraps round); null when there is nothing to cycle.
export function nextGroup(groups, groupId) {
  const i = groups.findIndex(g => g.id === groupId);
  if (i < 0 || groups.length < 2) return null;
  return groups[(i + 1) % groups.length].id;
}

// A spawn of `boss` just ended (kill or auto-reset) -> the groups for the spawns that follow.
// An officer's pick for the next spawn wins; otherwise alternation, if the boss has it on.
export function advanceGroups(boss, groups) {
  const later = parseLater(boss.later_groups);
  let next = later.length ? later[0] : null;
  if (!next && boss.alternate_groups) next = nextGroup(groups, boss.spawn_group);
  const rest = later.slice(1);
  return { spawnGroup: next, laterGroups: rest.some(Boolean) ? JSON.stringify(rest) : null };
}

// Groups of the next `count` spawns as shown in the schedule: explicit picks first, alternation
// filling the gaps. -> [groupId | null, ...]
export function groupsForSpawns(boss, groups, count) {
  const out = [boss.spawn_group || null];
  const later = parseLater(boss.later_groups);
  for (let k = 1; k < count; k++) {
    const pick = later[k - 1] || null;
    out.push(pick || (boss.alternate_groups ? nextGroup(groups, out[k - 1]) : null));
  }
  return out;
}

// Settings/assign input -> stored later list (only known group ids; trailing blanks dropped)
export function cleanLater(list, groupIds) {
  const arr = (Array.isArray(list) ? list : []).slice(0, MAX_LATER).map(x => (x && groupIds.has(String(x)) ? String(x) : null));
  while (arr.length && !arr[arr.length - 1]) arr.pop();
  return arr.length ? JSON.stringify(arr) : null;
}
