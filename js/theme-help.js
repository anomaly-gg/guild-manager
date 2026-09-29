// Theme toggle (persisted) and the Help & Guide modal

const THEME_ICONS = { sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>', moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>' };

// Theme
function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? null : 'light';
    if (next) document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('gm_theme', next || 'dark');
    document.getElementById('themeBtn').innerHTML = next === 'light' ? THEME_ICONS.sun : THEME_ICONS.moon;
}
// Apply saved theme
(function() {
    const saved = localStorage.getItem('gm_theme');
    if (saved === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        document.getElementById('themeBtn').innerHTML = THEME_ICONS.sun;
    }
})();

// Help modal
function showHelpModal() {
    const sections = [
        { icon: '&#127968;', title: 'Teams & invites', text: 'Create a team for your guild or join one with the 8-character invite code your leader shares (it lives in the team bar). Leaders and officers approve join requests when the team is set to invite-approval in Settings. Free accounts can be in one team; Premium removes that limit and raises the member cap from 10 to 100.' },
        { icon: '&#9203;', title: 'Timers', text: 'One shared countdown per boss. Start from a game preset (the whole boss list in one click) or add bosses one by one. Rules: fixed interval after the kill, daily, weekly, twice-daily or twice-weekly, with an optional spawn window and a location note. Tap <b>Killed</b> when it dies (or set the exact kill time) and everyone\'s countdown updates. Discord gets an alert before each spawn, and with the bot added to your server (Settings → Discord slash commands) anyone there can ask <b>/next</b> and members can log <b>/killed</b>. Premium adds boss templates, kill history and a public read-only timer page you can pin in Discord.' },
        { icon: '&#128197;', title: 'Events', text: 'Raids, GvGs, scrims and meetings. Members RSVP Going / Maybe / Can\'t and pick a role (Tank, Healer, DPS or whatever you set in Settings), so officers see the split at a glance. Sign-up caps, recurring events, a week view and per-event lineups. Officers mark attendance afterwards. For daily boss rallies, members check in from Discord with <b>/here</b> and a screenshot (or an officer runs <b>/rollcall</b>), officers review under Events → Attendance, and approved rallies award points automatically; suspicious check-ins are flagged (no kill logged that day, sent hours late, duplicate screenshot). Premium adds event templates, an attendance report and an iCal feed for your calendar app.' },
        { icon: '&#128101;', title: 'Roster', text: 'Everyone on the team with their class or role, who is online right now, and a weekly availability grid so you can pick raid times that actually work. Officers keep private notes, change team roles, and review join requests.' },
        { icon: '&#128142;', title: 'Loot & Points', text: 'Optional module, off by default: turn it on in Settings. Two loot modes: <b>Rotation</b> (default) is an ordered list of members; whoever is on top gets the next drop, logging it sends them to the bottom, and officers can nudge anyone up or down for attendance. <b>Points</b> is the classic DKP ledger: earn points for showing up, spend them on drops. Both keep a loot log, and Discord gets a note when a drop is logged. Premium adds wishlists, auctions and automatic point decay.' },
        { icon: '&#9881;', title: 'Settings', text: 'Discord webhook and which alerts to send, invite approval, RSVP role names, team timezone, which modules are shown, the points name, and leadership transfer. Leaders can delete the team here.' },
        { icon: '&#127775;', title: 'Free vs Premium', text: 'Free covers a full team: timers, events, roster and loot. Premium is for guilds that want more: unlimited teams and timers, up to 100 members, the public timer page, iCal feed, templates, kill history, attendance report, wishlists, auctions and decay. Start a 7-day trial from your account menu.' },
        { icon: '&#128276;', title: 'Phone alerts', text: 'Account menu → <b>Phone alerts</b> → Turn on alerts. You get a notification when a boss is about to spawn or is up, even with the app closed: one per team, updated in place, gone once the boss is killed or resets. Pick per team: spawning soon, spawned, and which spawn groups you follow. On iPhone, add Guild Manager to the Home Screen first and turn alerts on from there.' },
        { icon: '&#128274;', title: 'Account & data', text: 'Account menu → <b>Account &amp; data</b>. Choose whether times show in your device&rsquo;s timezone or the team&rsquo;s (boss schedules are always entered in team time). Download everything about you and the teams you lead as one JSON file, or delete your account: sign-in, memberships and personal entries go, team histories keep your past entries as "Deleted user". Teams you lead with other members must be transferred or deleted first.' },
        { icon: '&#128241;', title: 'On your phone', text: 'The site is built for phones first. Modules sit in the bottom bar, timers refresh in the background, and the account menu is under your avatar at the top right. Add the site to your home screen for a one-tap open.' },
    ];
    const items = sections.map(sec => `
        <details class="help-item">
            <summary><span class="help-icon">${sec.icon}</span><span>${sec.title}</span><span class="help-chev">&#9662;</span></summary>
            <div class="help-body">${sec.text}</div>
        </details>`).join('');
    const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)this.remove()">
            <div class="card modal-card modal-wide">
                <div class="help-head"><h2>Help &amp; guide</h2><button class="tbtn-icon" onclick="this.closest('.modal-backdrop').remove()" title="Close">&#10005;</button></div>
                <p class="tf-help" style="margin-bottom:10px">One entry per section of the app. Tap a section to expand it.</p>
                <div class="help-list">${items}</div>
            </div>
        </div>`;
    document.getElementById('deathModal').innerHTML = html;
}
