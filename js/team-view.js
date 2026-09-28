// Team view shell: state, openTeam(), module navigation, sub-views.
// Modules: Home · Timers · Events · Roster · Loot & Points · Settings (see OVERHAUL.md).

let teamBosses = [];
let teamSpawnGroups = [];   // officer-defined spawn groups; arrive with GET /bosses
let teamData = null;
let teamTab = 'home';
let bossViewMode = localStorage.getItem('gm_boss_view') || 'list';

const ICONS = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/></svg>',
    timers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/></svg>',
    events: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    roster: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.5a5 5 0 0 1 6 5"/></svg>',
    points: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};

// `tabs` are the legacy teamTab keys each module mounts under; `open` renders its default view.
const MODULES = [
    { id: 'home',     label: 'Home',          tabs: ['home'],                    open: () => loadAndRenderHome() },
    { id: 'timers',   label: 'Timers',        tabs: ['timers'],                  open: () => window.Timers ? window.Timers.open() : setTimeout(() => openModule('timers'), 50) },
    { id: 'events',   label: 'Events',        tabs: ['events'],                  open: () => window.Events ? window.Events.open() : setTimeout(() => openModule('events'), 50) },
    { id: 'roster',   label: 'Roster',        tabs: ['members', 'availability', 'requests'], open: () => window.Roster ? window.Roster.open('members') : setTimeout(() => openModule('roster'), 50) },
    { id: 'points',   label: 'Loot & Points', short: 'Points', tabs: ['rotation', 'loot', 'dkp'], open: () => window.Points ? window.Points.open(teamData?.team?.loot_mode === 'dkp' ? 'loot' : 'rotation') : setTimeout(() => openModule('points'), 50) },
    { id: 'settings', label: 'Settings',      tabs: ['settings'],                open: () => window.Settings ? window.Settings.open() : setTimeout(() => openModule('settings'), 50) },
];

const SUB_VIEWS = {
    roster: [
        { tab: 'members',      label: () => `Members (${teamData?.members?.length ?? 0})`, open: () => window.Roster.open('members') },
        { tab: 'availability', label: () => 'Availability',                                open: () => window.Roster.open('availability') },
        { tab: 'requests',     label: () => { const n = window.Roster?.pendingCount() || 0; return n ? `Requests (${n})` : 'Requests'; }, officer: true, open: () => window.Roster.open('requests') },
    ],
    points: [
        { tab: 'rotation', label: () => 'Rotation', when: () => teamData?.team?.loot_mode !== 'dkp', open: () => window.Points.open('rotation') },
        { tab: 'loot',     label: () => 'Loot log', open: () => window.Points.open('loot') },
        { tab: 'dkp',      label: () => ptsName(),  when: () => teamData?.team?.loot_mode === 'dkp', open: () => window.Points.open('dkp') },
    ],
};

function openModule(id) {
    const mod = MODULES.find(m => m.id === id);
    if (mod) mod.open();
}

function openSubView(moduleId, tab) {
    const sub = (SUB_VIEWS[moduleId] || []).find(s => s.tab === tab);
    if (sub) sub.open();
}

async function openTeam(teamId) {
    currentTeamId = teamId;
    const content = document.getElementById('mainContent');
    content.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

    // Everything Home needs, in flight at once (one round trip instead of three). The events
    // and settings responses land in the GET cache, so Home and Settings read them for free.
    const [data, bossesData] = await Promise.all([
        api('GET', `/api/teams/${teamId}`),
        api('GET', `/api/teams/${teamId}/bosses`).catch(() => ({})),
        api('GET', `/api/teams/${teamId}/events`).catch(() => ({})),
        api('GET', `/api/teams/${teamId}/settings`).then(s => { _pointsName = s.pointsName || 'DKP'; }).catch(() => {}),
    ]);
    if (data.error) { showToast(data.error); showTeamList(); return; }

    teamData = data;
    teamTab = 'home';
    teamBosses = bossesData.bosses || [];
    teamSpawnGroups = bossesData.groups || [];
    loadAndRenderHome();
}

async function loadTeamBosses(teamId) {
    const data = await api('GET', `/api/teams/${teamId}/bosses`);
    teamBosses = data.bosses || [];
    teamSpawnGroups = data.groups || [];
}

function renderTeamView() {
    const content = document.getElementById('mainContent');
    const team = teamData.team;
    const members = teamData.members;
    const canManage = team.my_role === 'leader' || team.my_role === 'officer';
    const enabled = MODULES.filter(m => m.id !== 'points' || team.modules?.points !== false);
    const mod = enabled.find(m => m.tabs.includes(teamTab)) || MODULES[0];

    const spinner = (id) => `<div id="${id}"><div class="empty-state"><div class="spinner"></div></div></div>`;
    let tabContent = '';
    switch (teamTab) {
        case 'home':         tabContent = spinner('homeContent'); break;
        case 'timers':       tabContent = spinner('timersContent'); break;
        case 'events':       tabContent = spinner('eventsContent'); break;
        case 'members':
        case 'availability':
        case 'requests':     tabContent = spinner('rosterContent'); break;
        case 'rotation':
        case 'loot':
        case 'dkp':          tabContent = spinner('pointsContent'); break;
        case 'settings':     tabContent = spinner('settingsContent'); break;
    }

    const subs = (SUB_VIEWS[mod.id] || []).filter(s => (!s.officer || canManage) && (!s.when || s.when()));
    const subNav = subs.length ? `<div class="sub-nav">${subs.map(s =>
        `<button class="${s.tab === teamTab ? 'active' : ''}" onclick="openSubView('${mod.id}','${s.tab}')">${escapeHtml(s.label())}</button>`
    ).join('')}</div>` : '';

    content.innerHTML = `
        <div class="card team-bar">
            <div class="team-title">
                <h2>${escapeHtml(team.name)}</h2>
                <span class="team-role ${team.my_role}">${team.my_role}</span>
            </div>
            <div class="team-meta">
                <span class="invite-chip" onclick="copyInvite('${team.invite_code}')" title="Copy invite code">Invite <code>${team.invite_code}</code></span>
                <button class="btn btn-sm btn-secondary" id="dndBtn" onclick="toggleDND()"></button>
                <button class="btn btn-sm btn-secondary" onclick="showTeamList()" title="Switch team">&#8646; Teams</button>
            </div>
        </div>
        <nav class="module-nav" aria-label="Team sections">
            ${enabled.map(m => `<button class="${m.id === mod.id ? 'active' : ''}" onclick="openModule('${m.id}')">${ICONS[m.id]}<span class="lbl-full">${m.label}</span><span class="lbl-short">${m.short || m.label}</span></button>`).join('')}
        </nav>
        ${subNav}
        <section class="module-content">${tabContent}</section>
        ${!team.premium_team ? '<div class="module-footer">Powered by <b>Guild Manager</b> &middot; <a href="#" onclick="showUpgradeModal();return false">Upgrade to Premium</a></div>' : ''}
    `;

    updateDNDBadge();
}
