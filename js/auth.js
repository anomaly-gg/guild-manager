// OAuth token landing, init(), login screen, user header, login/logout actions

// --- Init ---

// Check for token in URL (from OAuth redirect)
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('token')) {
    token = urlParams.get('token');
    localStorage.setItem('gm_token', token);
    window.history.replaceState({}, '', window.location.pathname);
}

// init() is called after the api() cache block below is set up (const/TDZ).

async function init() {
    if (!token) {
        showLogin();
        return;
    }
    let user = await api('GET', '/auth/me');
    // Retry once on failure (cold start)
    if (!user || user.error) {
        await new Promise(r => setTimeout(r, 1500));
        user = await api('GET', '/auth/me');
    }
    if (!user || user.error) {
        _clearApiCache();
        localStorage.removeItem('gm_token');
        token = '';
        showLogin();
        return;
    }
    currentUser = user;
    showUserInfo();
    showTeamList();
    import('./modules/push.js?v=20260930a').then(m => m.resume()).catch(() => {});   // phone alerts: keep this device registered
    // pricing.html links here with ?upgrade=monthly|lifetime; /discord/added sends ?discord=linked|cancelled|error
    const params = new URLSearchParams(location.search);
    const wanted = params.get('upgrade'), discord = params.get('discord');
    if (wanted || discord) history.replaceState(null, '', location.pathname);
    if (wanted && !(currentUser.premium && !currentUser.trial)) showUpgradeModal();
    if (discord === 'linked') showToast('Discord server linked. Try /next there.');
    else if (discord === 'cancelled') showToast('Discord link cancelled.');
    else if (discord === 'error') showToast('Could not link the Discord server. Try again from Settings.');
}

// --- Views ---

function showLogin() {
    document.getElementById('mainContent').innerHTML = `
        <section class="login">
            <div class="login-hero">
                <img src="icon.svg" alt="" class="login-logo">
                <h1>Guild Manager</h1>
                <p class="login-tag">Boss timers, raid planning and your roster, in one place your whole guild can see.</p>
            </div>
            <ul class="login-points">
                    <li>${ICONS.timers}<div><b>Timers</b><span>Shared spawn countdowns with Discord alerts and a public page to pin</span></div></li>
                    <li>${ICONS.events}<div><b>Events</b><span>RSVP by role, sign-up caps, lineups and attendance</span></div></li>
                    <li>${ICONS.roster}<div><b>Roster</b><span>Classes, weekly availability and who is online</span></div></li>
            </ul>
            <div class="card login-card">
                <h2>Sign in</h2>
                <button class="btn btn-discord" onclick="login()">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
                    Continue with Discord
                </button>
                <button class="btn btn-google" onclick="loginGoogle()">
                    <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/><path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/><path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0124 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/><path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 01-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>
                    Continue with Google
                </button>
                <div class="login-or"><span>or try it as a guest</span></div>
                <form class="login-guest" onsubmit="loginGuest();return false">
                    <input type="text" id="guestName" placeholder="Pick a name" maxlength="20" autocomplete="off">
                    <button type="submit" class="btn btn-secondary">Join as guest</button>
                </form>
                <p class="login-note">Guests can do everything except start a trial. Sign in with Discord or Google to keep your account.</p>
                <p class="login-legal"><a href="pricing.html">Pricing</a> · <a href="terms.html">Terms</a> · <a href="privacy.html">Privacy</a></p>
            </div>
        </section>`;
}

function showUserInfo() {
    const el = document.getElementById('userInfo');
    el.style.display = '';
    el.open = false;
    const plan = currentUser.trial ? `Trial · ${currentUser.trialDaysLeft}d left` : currentUser.premium ? 'Premium' : 'Free';
    document.getElementById('userName').textContent = currentUser.username;
    document.getElementById('userMenuName').textContent = currentUser.username;
    const planEl = document.getElementById('userPlan');
    planEl.textContent = plan;
    planEl.className = 'chip ' + (currentUser.premium && !currentUser.trial ? 'chip-accent' : currentUser.trial ? 'chip-success' : 'chip-muted');
    const avatar = document.getElementById('userAvatar');
    const initial = document.getElementById('userInitial');
    initial.textContent = (currentUser.username || '?').slice(0, 1).toUpperCase();
    const showInitial = () => { avatar.removeAttribute('src'); avatar.style.display = 'none'; initial.style.display = ''; };
    const src = avatarUrl(currentUser);
    if (src) {
        avatar.onerror = showInitial;   // expired hash, blocked CDN, offline: fall back to the initial badge
        avatar.src = src; avatar.style.display = ''; initial.style.display = 'none';
    } else showInitial();
    const upgradeBtn = document.getElementById('upgradeBtn');
    upgradeBtn.style.display = currentUser.premium && !currentUser.trial ? 'none' : '';
    upgradeBtn.textContent = currentUser.trial ? 'Keep Premium after the trial' : 'Upgrade to Premium';
}

function login() {
    window.location.href = API + '/auth/login';
}

function loginGoogle() {
    window.location.href = API + '/auth/google';
}

const loginGuest = guard('loginGuest', async function() {
    const username = document.getElementById('guestName').value.trim();
    if (!username || username.length < 2) return showToast('Username must be at least 2 characters');
    const data = await api('POST', '/auth/guest', { username });
    if (data.error) { showToast(data.error); return; }
    token = data.token;
    localStorage.setItem('gm_token', token);
    init();
});

function logout() {
    const tok = token;
    import('./modules/push.js?v=20260930a').then(m => m.forget(tok)).catch(() => {});   // this device stops alerting for this account
    _clearApiCache();
    localStorage.removeItem('gm_token');
    token = '';
    currentUser = null;
    document.getElementById('userInfo').style.display = 'none';
    showLogin();
}
