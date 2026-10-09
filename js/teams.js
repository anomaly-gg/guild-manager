// Team list, create/join modals, membership actions (role, kick, leave, delete)

function _teamModal(title, fieldsHtml, submitLabel, onSubmit) {
    const host = document.getElementById('deathModal');
    host.innerHTML = `<div class="modal-backdrop"><div class="card modal-card"><h2>${title}</h2>
        <form class="tform" id="teamForm">${fieldsHtml}
            <div class="tf-actions tf-wide"><button type="button" class="btn btn-secondary" data-close="1">Cancel</button><button type="submit" class="btn btn-primary">${submitLabel}</button></div>
        </form></div></div>`;
    const back = host.firstElementChild;
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) host.innerHTML = ''; });
    back.querySelector('#teamForm').addEventListener('submit', (e) => { e.preventDefault(); onSubmit(); });
    setTimeout(() => back.querySelector('input')?.focus(), 0);
}

function showCreateTeamModal() {
    _teamModal('New team', `
        <label class="tf-field tf-wide"><span>Team name</span><input type="text" id="teamName" maxlength="60" required placeholder="e.g. Shadow Guild"></label>
        <p class="tf-help tf-wide">You become the leader. Share the invite code from the team bar to bring people in.</p>`, 'Create team', createTeam);
}

function showJoinTeamModal() {
    _teamModal('Join a team', `
        <label class="tf-field tf-wide"><span>Invite code</span><input type="text" id="inviteCode" maxlength="12" required placeholder="e.g. AbCd1234" autocapitalize="off" autocomplete="off"></label>
        <p class="tf-help tf-wide">Ask your leader for the 8-character code shown in their team bar.</p>`, 'Join', joinTeam);
}

async function showTeamList() {
    currentTeamId = null;
    const content = document.getElementById('mainContent');
    content.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

    const data = await api('GET', '/api/teams');
    const teams = data.teams || [];
    const actions = `<div class="teams-actions">
        <button class="btn btn-secondary" onclick="showJoinTeamModal()">Join with code</button>
        <button class="btn btn-primary" onclick="showCreateTeamModal()">+ New team</button>
    </div>`;

    let html = `<div class="teams-head"><h2>Your teams</h2>${teams.length ? actions : ''}</div>`;
    if (teams.length === 0) {
        html += `<div class="t-empty card">
            <div class="t-empty-title">No teams yet</div>
            <div class="t-empty-sub">Create one for your guild, or join with the invite code your leader shares.</div>
            ${actions}
        </div>`;
    } else {
        html += '<div class="trows">' + teams.map(t => {
            const initials = t.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
            const stats = [`${t.member_count} member${t.member_count !== 1 ? 's' : ''}`,
                `<span class="${t.online_count ? 't-ok' : ''}">${t.online_count || 0} online</span>`,
                t.upcoming_events_24h > 0 ? `<span class="t-warnish">${t.upcoming_events_24h} event${t.upcoming_events_24h !== 1 ? 's' : ''} today</span>` : ''].filter(Boolean).join(' · ');
            return `
            <article class="trow-team" onclick="openTeam('${t.id}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter')openTeam('${t.id}')">
                ${t.team_icon ? `<img class="trow-icon" src="${escapeHtml(t.team_icon)}" alt="">` : `<span class="trow-icon trow-initials">${escapeHtml(initials)}</span>`}
                <div class="trow-body">
                    <div class="trow-top"><span class="trow-name">${escapeHtml(t.name)}</span><span class="team-role ${t.role}">${t.role}</span></div>
                    <div class="trow-meta">${t.description ? escapeHtml(t.description) + ' · ' : ''}${stats}</div>
                </div>
                <span class="trow-chev">&#8250;</span>
            </article>`;
        }).join('') + '</div>';
        if (!currentUser?.premium) html += '<p class="teams-note">Free plan includes one team you lead; joining others is unlimited. <a href="#" onclick="showUpgradeModal();return false">Premium</a> removes the limit.</p>';
    }
    content.innerHTML = html;
}

const createTeam = guard('createTeam', async function() {
    const name = document.getElementById('teamName').value.trim();
    if (!name) return;
    const data = await api('POST', '/api/teams', { name });
    if (data.error) { showToast(data.error); document.getElementById('deathModal').innerHTML = ''; return; }
    document.getElementById('deathModal').innerHTML = '';
    showToast(`Team "${name}" created!`);
    _invalidateForMutation('/api/teams');
    showChooseGameModal(data.team.id);
});

// New-team onboarding: pick the game (loads its boss preset + sets the team timezone to the
// server clock) or skip. Either way the team opens afterwards.
async function showChooseGameModal(teamId) {
    const host = document.getElementById('deathModal');
    host.innerHTML = `<div class="modal-backdrop"><div class="card modal-card"><div class="spinner"></div></div></div>`;
    const data = await api('GET', '/api/presets');
    const presets = data.presets || [];
    if (!presets.length) { host.innerHTML = ''; openTeam(teamId); return; }

    const gameBtns = presets.map((p, i) =>
        `<button type="button" class="menu-item" data-pick="${i}"><b>${escapeHtml(p.game)}</b> — ${p.bosses.length} timers ready</button>`).join('');
    host.innerHTML = `<div class="modal-backdrop"><div class="card modal-card"><h2>What game is this guild for?</h2>
        <p class="tf-help">Picking a game loads its boss timers and sets the team clock to the server's timezone. You can change or remove any of it later.</p>
        <div data-role="choices">${gameBtns}</div>
        <div class="tf-actions"><button type="button" class="btn btn-secondary" data-skip="1">Other game / skip</button></div>
    </div></div>`;
    const back = host.firstElementChild;
    back.addEventListener('click', async (e) => {
        if (e.target.closest('[data-skip]')) { host.innerHTML = ''; openTeam(teamId); return; }
        const pickBtn = e.target.closest('[data-pick]');
        if (!pickBtn) return;
        const preset = presets[Number(pickBtn.dataset.pick)];
        const clusters = preset.clusters || [];
        if (clusters.length > 1) {
            const box = back.querySelector('[data-role="choices"]');
            back.querySelector('h2').textContent = 'Which server cluster?';
            box.innerHTML = clusters.map((c, i) =>
                `<button type="button" class="menu-item" data-cluster="${i}"><b>${escapeHtml(c.label)}</b> — timers follow this server clock</button>`).join('');
            box.onclick = (ev) => {
                const cb = ev.target.closest('[data-cluster]');
                if (cb) _applyGameChoice(teamId, preset, clusters[Number(cb.dataset.cluster)]);
            };
            return;
        }
        _applyGameChoice(teamId, preset, clusters[0] || null);
    });
}

async function _applyGameChoice(teamId, preset, cluster) {
    const host = document.getElementById('deathModal');
    host.innerHTML = `<div class="modal-backdrop"><div class="card modal-card"><div class="spinner"></div></div></div>`;
    if (cluster?.tz) await api('PUT', `/api/teams/${teamId}/settings`, { timezone: cluster.tz });
    const res = await api('POST', `/api/teams/${teamId}/bosses/presets`, { presetId: preset.id });
    host.innerHTML = '';
    if (res.error) showToast(res.error);
    else showToast(`${preset.game}: ${res.added.length} timers added${cluster ? ` · team clock set to ${cluster.label}` : ''}`);
    openTeam(teamId);
}

const joinTeam = guard('joinTeam', async function() {
    const code = document.getElementById('inviteCode').value.trim();
    if (!code) return;
    const data = await api('POST', `/api/invite/${code}`);
    if (data.error) { showToast(data.error); document.getElementById('deathModal').innerHTML = ''; return; }
    document.getElementById('deathModal').innerHTML = '';
    if (data.pending) {
        showToast('Join request sent! Waiting for approval.');
    } else {
        showToast(`Joined ${data.team.name}!`);
        _invalidateForMutation('/api/teams');
        showTeamList();
    }
});

const deleteTeam = guard('deleteTeam', async function(teamId) {
    if (!(await confirmDialog('Delete this team? This cannot be undone.', { confirmLabel: 'Delete team' }))) return;
    const res = await api('DELETE', `/api/teams/${teamId}`);
    if (res.error) { showToast(res.error); return; }
    showToast('Team deleted');
    _invalidateForMutation('/api/teams');
    showTeamList();
});

const leaveTeam = guard('leaveTeam', async function(teamId) {
    if (!(await confirmDialog('Leave this team?', { confirmLabel: 'Leave' }))) return;
    const res = await api('POST', `/api/teams/${teamId}/leave`);
    if (res.error) { showToast(res.error); return; }
    showToast('Left team');
    _invalidateForMutation('/api/teams');
    showTeamList();
});
