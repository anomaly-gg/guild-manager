// Background loops: boss/event countdown ticks, periodic refreshes, activity heartbeat

setInterval(() => {
    if (!currentTeamId) return;
    // In-tab alerts: one notification for the team, kept in step with the timers (js/notifications.js)
    syncTabAlert(currentTeamId, teamData?.team?.name || 'Guild Manager', teamBosses);
    for (const boss of teamBosses) {
        const remaining = boss.next_spawn - Date.now();
        const isSpawned = remaining <= 0 || boss.status === 'spawned';
        const alertMs = (boss.alert_minutes || 5) * 60000;

        // Update Home rows (the Timers module runs its own tick)
        if (teamTab !== 'home') continue;
        const el = document.querySelector(`[data-boss-id="${boss.id}"] .boss-countdown`);
        if (!el) continue;
        if (isSpawned) {
            el.textContent = 'SPAWNED';
            el.className = 'when boss-countdown spawned';   // keep 'when': it carries the Home font size
        } else {
            el.textContent = formatTime(remaining);
            el.className = remaining <= alertMs ? 'when boss-countdown warning-text' : 'when boss-countdown active';
        }
    }
}, 1000);

// Activity heartbeat every 5 minutes
setInterval(async () => {
    if (!currentTeamId) return;
    await api('POST', `/api/teams/${currentTeamId}/heartbeat`);
}, 300000);
