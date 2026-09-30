// Premium: upgrade modal, free trial, Gumroad checkout (new tab + activation poll), license key entry

const BILL_POLL_MS = 5000;
const BILL_POLL_MAX_MS = 3 * 60 * 1000;
let _billPoll = null;

function showUpgradeModal() {
    const isGuest = currentUser?.authType === 'guest';
    const onTrial = !!currentUser?.trial;
    const trialUsed = !!currentUser?.trialUsed;

    const ownPlan = currentUser?.premium && !onTrial ? (currentUser.premiumType || 'lifetime') : null;   // legacy grants have no type
    let notice = '';
    if (isGuest) {
        notice = '<div class="bill-note bill-note-warn">Sign in with Discord or Google first, so your purchase stays with an account you can get back into. Guests can\'t start a trial or buy Premium.</div>';
    } else if (onTrial) {
        notice = `<div class="bill-note bill-note-success">Your trial has <b>${currentUser.trialDaysLeft} day${currentUser.trialDaysLeft === 1 ? '' : 's'}</b> left. Buy a plan to keep Premium when it ends.</div>`;
    } else if (ownPlan === 'lifetime') {
        notice = '<div class="bill-note bill-note-success"><b>You have Lifetime Premium.</b> There is nothing more to buy.</div>';
    } else if (ownPlan === 'monthly') {
        notice = '<div class="bill-note bill-note-success"><span><b>You&rsquo;re on the monthly plan.</b> Switch to Lifetime below, then cancel the monthly membership on Gumroad so it stops billing.</span></div>';
    } else if (!trialUsed) {
        notice = '<div class="bill-note bill-note-success"><span><b>Try Premium free for 7 days.</b> No payment details, one trial per account.</span><button class="btn btn-sm btn-secondary" data-act="trial">Start free trial</button></div>';
    }

    const plans = ownPlan === 'lifetime' ? '' : `
        <div class="bill-plans">
            ${ownPlan === 'monthly' ? '' : `<button class="bill-plan" data-act="buy" data-plan="monthly" ${isGuest ? 'disabled' : ''}>
                <span class="bill-plan-name">Monthly</span>
                <span class="bill-plan-price">$2<small>/ month</small></span>
                <span class="bill-plan-sub">Cancel any time</span>
            </button>`}
            <button class="bill-plan bill-plan-featured" data-act="buy" data-plan="lifetime" ${isGuest ? 'disabled' : ''}>
                <span class="chip chip-accent">Best value</span>
                <span class="bill-plan-name">${ownPlan === 'monthly' ? 'Switch to Lifetime' : 'Lifetime'}</span>
                <span class="bill-plan-price">$10<small>once</small></span>
                <span class="bill-plan-sub">Pay once, keep it forever</span>
            </button>
        </div>`;

    document.getElementById('deathModal').innerHTML = `
        <div class="modal-backdrop">
            <div class="card modal-card bill-modal">
                <div class="help-head"><h2>Upgrade to Premium</h2><button class="tbtn-icon" data-close title="Close">&#10005;</button></div>
                <p class="tf-help">Free covers 1 team, 10 members and 15 timers. Premium adds unlimited teams and timers, up to 100 members, the public timer page, Discord alerts in up to 3 channels, templates, kill history, the attendance report, calendar feed, wishlists, auctions and decay. <a href="pricing.html" target="_blank" rel="noopener">Compare plans</a></p>
                ${notice}
                ${plans}
                ${ownPlan === 'lifetime' ? '' : '<p class="tf-help">Checkout opens on Gumroad in a new tab and takes cards and PayPal. Premium switches on here by itself within a minute of paying.</p>'}
                <details class="bill-key">
                    <summary>Already bought? Enter your license key</summary>
                    <form class="bill-key-form" data-act="activate">
                        <input id="licenseKeyInput" placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX" autocomplete="off" spellcheck="false" ${isGuest ? 'disabled' : ''}>
                        <button class="btn btn-primary" type="submit" ${isGuest ? 'disabled' : ''}>Activate</button>
                    </form>
                    <p class="tf-help">It's in the email Gumroad sent after your purchase, and on your Gumroad library page.</p>
                </details>
                <div class="bill-status" id="billStatus"></div>
            </div>
        </div>`;

    const back = document.querySelector('#deathModal .modal-backdrop');
    back.addEventListener('click', (e) => {
        if (e.target === back || e.target.closest('[data-close]')) { closeUpgradeModal(); return; }
        const act = e.target.closest('[data-act]');
        if (!act || act.tagName === 'FORM') return;
        if (act.dataset.act === 'trial') startFreeTrial();
        if (act.dataset.act === 'buy') checkout(act.dataset.plan);
    });
    back.querySelector('form[data-act="activate"]').addEventListener('submit', (e) => { e.preventDefault(); activateLicense(); });
}

function closeUpgradeModal() {
    document.getElementById('deathModal').innerHTML = '';
}

function billStatus(html, kind) {
    const el = document.getElementById('billStatus');
    if (el) el.innerHTML = html ? `<div class="bill-note bill-note-${kind || 'muted'}">${html}</div>` : '';
}

async function refreshPremiumState() {
    _apiCache.delete('/auth/me');
    const user = await api('GET', '/auth/me');
    if (user && !user.error) { currentUser = user; showUserInfo(); }
    return user;
}

async function onPremiumActivated(user) {
    stopActivationPoll();
    closeUpgradeModal();
    showToast(user.premiumType === 'lifetime' ? 'Lifetime Premium activated!' : 'Premium activated!');
    if (currentTeamId) openTeam(currentTeamId); else showTeamList();
}

// --- Actions ---

const startFreeTrial = guard('startFreeTrial', async function() {
    const data = await api('POST', '/api/start-trial');
    if (data.error) { showToast(data.error); return; }
    closeUpgradeModal();
    showToast('Free trial started! You have 7 days of Premium.');
    await refreshPremiumState();
    if (currentTeamId) openTeam(currentTeamId); else showTeamList();
});

const checkout = guard('checkout', async function(plan) {
    // Open the tab synchronously so mobile browsers don't treat it as a pop-up, then point it at Gumroad.
    const tab = window.open('about:blank', '_blank');
    const data = await api('POST', '/api/checkout', { type: plan });
    if (data.error || !data.url) { if (tab) tab.close(); billStatus(data.error || 'Checkout is not available right now', 'warn'); return; }
    if (tab) { tab.opener = null; tab.location.href = data.url; }
    billStatus(`Waiting for your ${plan} purchase on Gumroad&hellip; ${tab ? '' : `<a href="${data.url}" target="_blank" rel="noopener">Open checkout</a> &middot; `}Leave this open; Premium switches on by itself. Nothing happening? Paste your license key above.`, 'muted');
    startActivationPoll();
});

// Flips only when the plan actually changes from what it was when checkout opened, so an account
// that is already Premium is not reported as "activated" by its own existing plan.
function startActivationPoll() {
    stopActivationPoll();
    const started = Date.now();
    const planBefore = currentUser?.premium && !currentUser.trial ? currentUser.premiumType : null;
    _billPoll = setInterval(async () => {
        if (!document.getElementById('billStatus')) { stopActivationPoll(); return; }   // modal closed
        if (Date.now() - started > BILL_POLL_MAX_MS) { stopActivationPoll(); return; }
        const user = await refreshPremiumState();
        if (user && user.premium && !user.trial && user.premiumType !== planBefore) onPremiumActivated(user);
    }, BILL_POLL_MS);
}

function stopActivationPoll() {
    if (_billPoll) { clearInterval(_billPoll); _billPoll = null; }
}

const activateLicense = guard('activateLicense', async function() {
    const input = document.getElementById('licenseKeyInput');
    const key = (input?.value || '').trim();
    if (!key) { billStatus('Paste the license key from your Gumroad email first.', 'warn'); return; }
    billStatus('Checking your key with Gumroad&hellip;', 'muted');
    const data = await api('POST', '/api/activate-license', { licenseKey: key });
    if (data.error) { billStatus(data.error, 'warn'); return; }
    const user = await refreshPremiumState();
    if (user && user.premium) onPremiumActivated(user);
    else billStatus('The key was accepted but Premium did not switch on. Reload the page, and email us if it still shows Free.', 'warn');
});
