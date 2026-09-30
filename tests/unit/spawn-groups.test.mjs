// Spawn-group roles per Discord server, no server (worker/src/lib/spawn-groups.js): what is stored,
// what each server sees, and filing roles saved before roles were per server.
import { cleanGroups, groupsIn, groupTag, fileLegacyRoles } from '../../worker/src/lib/spawn-groups.js';

let pass = 0, fail = 0;
const check = (n, c, i = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '   <- ' + JSON.stringify(i))); };

const A = '100000000000000001', B = '200000000000000002';   // two servers
const VIS_A = '111111111111111111', VIS_B = '222222222222222222', OLD = '333333333333333333';

// ---- saving
const saved = cleanGroups([
  { id: 'vis1', name: 'Viserion', roles: { [A]: VIS_A, [B]: VIS_B, 'bad id!': VIS_A, [A + '9']: 'not-a-role' } },
  { id: 'rit1', name: '@Ritwal' },
  { id: 'old1', name: 'Old', roleId: OLD },
]);
check('a role per server kept, bad entries dropped', JSON.stringify(saved[0].roles) === JSON.stringify({ [A]: VIS_A, [B]: VIS_B }) && saved[0].roleId === null, saved[0]);
check('no roles: empty map, no role', JSON.stringify(saved[1].roles) === '{}' && saved[1].roleId === null && saved[1].name === 'Ritwal', saved[1]);
check('a role saved the old way is kept as it is', saved[2].roleId === OLD && JSON.stringify(saved[2].roles) === '{}', saved[2]);
check('old role that is also in the map is not kept twice', cleanGroups([{ name: 'X', roleId: VIS_A, roles: { [A]: VIS_A } }])[0].roleId === null);

// ---- what each server sees
check('server A sees its own role', groupTag(groupsIn(saved, A), 'vis1') === `<@&${VIS_A}>`);
check('server B sees its own role', groupTag(groupsIn(saved, B), 'vis1') === `<@&${VIS_B}>`);
check('a server the group has no role in: plain @Name', groupTag(groupsIn(saved, '999999'), 'vis1') === '@Viserion');
check('channel whose server is not known yet: plain @Name', groupTag(groupsIn(saved, null), 'vis1') === '@Viserion');
check('an old-style role still shows everywhere, as before', groupTag(groupsIn(saved, B), 'old1') === `<@&${OLD}>` && groupTag(groupsIn(saved, null), 'old1') === `<@&${OLD}>`);
check('groupsIn leaves the stored groups alone', saved[0].roleId === null && !('roleId' in (saved[0].roles)));

// ---- filing old roles under their server
const servers = [{ guildId: A, roles: [{ id: VIS_A }] }, { guildId: B, roles: [{ id: OLD }] }];
const filed = fileLegacyRoles(saved, servers);
check('old role filed under the server that has it', filed.changed && JSON.stringify(filed.groups[2].roles) === JSON.stringify({ [B]: OLD }) && filed.groups[2].roleId === null, filed.groups[2]);
check('groups without an old role untouched', filed.groups[0] === saved[0] && filed.groups[1] === saved[1]);
const orphan = fileLegacyRoles([{ id: 'x', name: 'X', roles: {}, roleId: '444444444444444444' }], servers);
check('a role no linked server has stays as it is (nothing lost)', !orphan.changed && orphan.groups[0].roleId === '444444444444444444', orphan);
const merge = fileLegacyRoles([{ id: 'y', name: 'Y', roles: { [B]: VIS_B }, roleId: VIS_A }], servers);
check('filing keeps roles already picked in other servers', JSON.stringify(merge.groups[0].roles) === JSON.stringify({ [B]: VIS_B, [A]: VIS_A }), merge.groups[0]);

console.log(`\n${pass}/${pass + fail} checks passed`);
