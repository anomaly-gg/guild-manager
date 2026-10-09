// Loot & Points module (optional per team). Two loot modes, chosen in Settings:
//   rotation (default) — ordered member list; logging a drop sends the recipient to the bottom
//   dkp               — points standings/history/awards + auctions (premium)
// Plus the loot log + wishlist (premium) in both modes. ES module; uses shell globals by name. window.Points.

import { esc } from './timer-cards.js?v=20260923e';

let tab = 'loot';
let loot = [], wishes = [], balances = [], history = [], auctions = [], order = [];
let search = '';
let showHistory = false;

const root = () => document.getElementById('pointsContent');
const modalHost = () => document.getElementById('deathModal');
const team = () => teamData?.team;
const members = () => teamData?.members || [];
const isOfficer = () => team()?.my_role === 'leader' || team()?.my_role === 'officer';
const isPremium = () => !!team()?.premium_team;
const me = () => currentUser?.id;
const lootMode = () => team()?.loot_mode === 'dkp' ? 'dkp' : 'rotation';
const pts = () => ptsName();
const fmtDate = (sec) => new Date(sec * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });

// ---------------------------------------------------------------- open / data

export async function open(which = 'loot') {
    tab = ['rotation', 'loot', 'dkp'].includes(which) ? which : 'loot';
    if (tab === 'dkp' && lootMode() !== 'dkp') tab = 'rotation';
    if (tab === 'rotation' && lootMode() === 'dkp') tab = 'loot';
    teamTab = tab;
    renderTeamView();
    await load();
    if (teamTab !== tab) return;
    render();
}

async function load() {
    const T = currentTeamId;
    if (tab === 'rotation') {
        const r = await api('GET', `/api/teams/${T}/rotation`);
        order = r.order || [];
    } else if (tab === 'loot') {
        const [l, w] = await Promise.all([
            api('GET', `/api/teams/${T}/loot`),
            isPremium() ? api('GET', `/api/teams/${T}/wishlist`).catch(() => ({})) : Promise.resolve({}),
        ]);
        loot = l.loot || []; wishes = w.wishes || [];
    } else {
        const [b, h, a] = await Promise.all([
            api('GET', `/api/teams/${T}/dkp`),
            api('GET', `/api/teams/${T}/dkp/history`),
            isPremium() ? api('GET', `/api/teams/${T}/auctions`).catch(() => ({})) : Promise.resolve({}),
        ]);
        balances = b.balances || []; history = h.history || []; auctions = a.auctions || [];
    }
}

async function reload() { await load(); if (teamTab === tab) render(); }

// ---------------------------------------------------------------- render

function render() {
    const el = root();
    if (!el) return;
    el.innerHTML = tab === 'rotation' ? rotationHtml() : tab === 'loot' ? lootHtml() : pointsHtml();
    el.onclick = onClick;
    el.oninput = (e) => { if (e.target.dataset.role === 'search') { search = e.target.value; const l = el.querySelector('[data-role="list"]'); if (l) l.innerHTML = lootRowsHtml(); } };
}

function premiumTeaser(text) {
    return `<div class="p-teaser card"><span>${text}</span><button class="btn btn-sm btn-primary" data-action="upgrade">Premium</button></div>`;
}

// --- loot
function lootRowsHtml() {
    const q = search.trim().toLowerCase();
    const list = q ? loot.filter(l => [l.item_name, l.boss_name, l.recipient_name].some(v => (v || '').toLowerCase().includes(q))) : loot;
    if (!loot.length) return `<div class="t-empty card"><div class="t-empty-title">No loot logged yet</div><div class="t-empty-sub">Log who received what from which boss. ${lootMode() === 'dkp' ? `If it cost ${esc(pts())}, the points are deducted automatically.` : 'Logging a drop moves that member to the bottom of the rotation.'}</div>${isOfficer() ? '<button class="btn btn-primary" data-action="addloot">+ Log loot</button>' : ''}</div>`;
    if (!list.length) return `<div class="t-empty card"><div class="t-empty-title">No loot matches “${esc(search)}”</div></div>`;
    return list.map(l => `
        <article class="prow">
            <div class="prow-icon">${ICON.loot}</div>
            <div class="prow-body">
                <div class="prow-top"><span class="prow-title">${esc(l.item_name)}</span>${l.boss_name && l.boss_name !== 'Unknown' ? `<span class="e-dim">from ${esc(l.boss_name)}</span>` : ''}</div>
                <div class="prow-meta"><span class="p-pill">${esc(l.recipient_name)}</span>${l.dkp_cost && lootMode() === 'dkp' ? `<span class="chip chip-warn">−${l.dkp_cost} ${esc(pts())}</span>` : ''}<span class="e-dim">${fmtDate(l.created_at)} · by ${esc(l.noted_by_name || '')}</span></div>
            </div>
            ${isOfficer() ? `<button class="tbtn-icon tbtn-icon-danger" data-action="delloot" data-id="${l.id}" title="Remove">${ICON.x}</button>` : ''}
        </article>`).join('');
}

function wishlistHtml() {
    if (!isPremium()) return premiumTeaser('Loot wishlist: members call dibs on items with a priority, so officers know who wants what.');
    const P = { 1: ['chip-muted', 'Low'], 2: ['chip-warn', 'Med'], 3: ['chip-danger', 'High'] };
    const rows = wishes.map(w => `
        <article class="prow prow-sm">
            <div class="prow-body">
                <div class="prow-top"><span class="prow-title">${esc(w.item_name)}</span>${w.boss_name ? `<span class="e-dim">from ${esc(w.boss_name)}</span>` : ''}<span class="chip ${P[w.priority]?.[0] || 'chip-muted'}">${P[w.priority]?.[1] || 'Low'}</span></div>
                <div class="prow-meta"><span class="p-pill">${esc(w.username)}</span></div>
            </div>
            ${(w.user_id === me() || isOfficer()) ? `<button class="tbtn-icon tbtn-icon-danger" data-action="delwish" data-id="${w.id}" title="Remove">${ICON.x}</button>` : ''}
        </article>`).join('');
    return `<div class="p-section-head"><h3 class="t-h3" style="margin:0">Wishlist</h3><button class="btn btn-sm btn-secondary" data-action="addwish">+ Wish</button></div>
        ${rows || '<div class="t-empty-sub">Nothing on the wishlist yet.</div>'}`;
}

function lootHtml() {
    return `
        <div class="timers-toolbar">
            <input type="search" class="timers-search" data-role="search" placeholder="Search items, bosses, members" value="${esc(search)}" autocomplete="off">
            ${isOfficer() ? '<button class="btn btn-primary" data-action="addloot">+ Log loot</button>' : ''}
        </div>
        <div class="timers-summary">${loot.length} drop${loot.length !== 1 ? 's' : ''} logged${loot.length ? ` · latest ${esc(loot[0].item_name)} → ${esc(loot[0].recipient_name)}` : ''}</div>
        <div class="prows" data-role="list">${lootRowsHtml()}</div>
        <div class="p-section">${wishlistHtml()}</div>`;
}

// --- rotation
function rotationRowsHtml() {
    if (!order.length) return '<div class="t-empty card"><div class="t-empty-title">Nobody in the rotation yet</div></div>';
    return order.map((m, i) => {
        const initials = esc((m.username || '?').slice(0, 2).toUpperCase());
        const src = avatarUrl(m);
        const avatar = src ? avatarImg(src, 'rot-avatar', initials) : `<span class="rot-avatar r-initials">${initials}</span>`;
        const last = m.last_item ? `last drop: ${esc(m.last_item)} · ${fmtDate(m.last_at)}` : 'no drops yet';
        const actions = isOfficer() ? `
            <div class="rot-actions">
                <button class="btn btn-sm btn-primary" data-action="took" data-id="${m.id}">Took loot</button>
                <details class="menu" data-role="menu"><summary class="btn btn-sm btn-secondary" title="Move">&#8943;</summary><div class="menu-list">
                    <button class="menu-item" data-action="move" data-id="${m.id}" data-to="up" ${i === 0 ? 'disabled' : ''}>Move up</button>
                    <button class="menu-item" data-action="move" data-id="${m.id}" data-to="down" ${i === order.length - 1 ? 'disabled' : ''}>Move down</button>
                    <button class="menu-item" data-action="move" data-id="${m.id}" data-to="top" ${i === 0 ? 'disabled' : ''}>Send to top</button>
                    <button class="menu-item" data-action="move" data-id="${m.id}" data-to="bottom" ${i === order.length - 1 ? 'disabled' : ''}>Send to bottom</button>
                </div></details>
            </div>` : '';
        return `
        <article class="prow rot-row ${i === 0 ? 'rot-next' : ''} ${m.id === me() ? 'mine' : ''}">
            <div class="p-rank ${i === 0 ? 'top' : ''}">${i + 1}</div>
            ${avatar}
            <div class="prow-body">
                <div class="prow-top"><span class="prow-title">${esc(m.username)}${m.id === me() ? ' <span class="e-dim">(you)</span>' : ''}</span>${i === 0 ? '<span class="chip chip-success">Next</span>' : ''}${m.game_role ? `<span class="p-pill">${esc(m.game_role)}</span>` : ''}</div>
                <div class="prow-meta"><span class="e-dim">${last}</span></div>
            </div>
            ${actions}
        </article>`;
    }).join('');
}

function rotationHtml() {
    const next = order[0];
    const myIdx = order.findIndex(m => m.id === me());
    return `
        <div class="timers-toolbar">
            <div class="timers-summary" style="margin:0">${next ? `Next up: <b class="t-ok">${esc(next.username)}</b>` : 'Nobody in the rotation'}${myIdx > 0 ? ` · you are #${myIdx + 1}` : myIdx === 0 ? ' · that is you' : ''}</div>
            <div class="header-spacer"></div>
            ${isOfficer() ? '<button class="btn btn-primary" data-action="addloot">+ Log loot</button>' : ''}
        </div>
        <p class="rot-explain">Whoever is on top gets the next drop. Logging their loot sends them to the bottom; new members start at the bottom.${isOfficer() ? ' Use the &#8943; menu to nudge someone for attendance.' : ''}</p>
        <div class="prows">${rotationRowsHtml()}</div>
        ${team()?.my_role === 'leader' && order.some(m => m.loot_pos !== null) ? '<button class="e-past-toggle" data-action="resetrotation">Reset to join order</button>' : ''}`;
}

// --- points
function standingsHtml() {
    if (!balances.length) return `<div class="t-empty card"><div class="t-empty-title">No ${esc(pts())} recorded yet</div><div class="t-empty-sub">Award points for attendance and kills; loot costs deduct them. Standings update instantly.</div>${isOfficer() ? `<button class="btn btn-primary" data-action="award">+ Award ${esc(pts())}</button>` : ''}</div>`;
    return balances.map((b, i) => `
        <article class="prow prow-sm ${b.user_id === me() ? 'mine' : ''}">
            <div class="p-rank ${i < 3 ? 'top' : ''}">${i + 1}</div>
            <div class="prow-body"><div class="prow-top"><span class="prow-title">${esc(b.username)}${b.user_id === me() ? ' <span class="e-dim">(you)</span>' : ''}</span></div></div>
            <div class="p-balance ${b.balance >= 0 ? 'pos' : 'neg'}">${b.balance >= 0 ? '+' : ''}${b.balance}</div>
        </article>`).join('');
}

function historyHtml() {
    if (!history.length) return '<div class="t-empty-sub">No history yet.</div>';
    return history.map(h => `<div class="t-row t-row-sm"><span><b>${esc(h.username)}</b> <span class="e-dim">· ${esc(h.reason)} · by ${esc(h.created_by_name)} · ${fmtDate(h.created_at)}</span></span><span class="p-balance ${h.amount >= 0 ? 'pos' : 'neg'}">${h.amount >= 0 ? '+' : ''}${h.amount}</span></div>`).join('');
}

function auctionsHtml() {
    if (!isPremium()) return premiumTeaser(`${esc(pts())} auctions: put an item up, members bid with their points, the winner is charged automatically.`);
    const open = auctions.filter(a => a.status === 'open');
    const closed = auctions.filter(a => a.status !== 'open').slice(0, 10);
    const openRows = open.map(a => `
        <article class="prow">
            <div class="prow-icon">${ICON.gavel}</div>
            <div class="prow-body">
                <div class="prow-top"><span class="prow-title">${esc(a.item_name)}</span><span class="chip chip-success">Open</span></div>
                <div class="prow-meta"><span class="e-dim">by ${esc(a.started_by_name)} · ${a.bid_count} bid${a.bid_count !== 1 ? 's' : ''} · top <b>${a.top_bid || a.min_bid || 0}</b> ${esc(pts())}</span></div>
            </div>
            <div class="p-bid"><input type="number" min="${(a.top_bid || a.min_bid || 0) + 1}" placeholder="${(a.top_bid || a.min_bid || 0) + 1}" data-bid="${a.id}"><button class="btn btn-sm btn-primary" data-action="bid" data-id="${a.id}">Bid</button>${isOfficer() ? `<button class="btn btn-sm btn-secondary" data-action="closeauction" data-id="${a.id}">Close</button>` : ''}</div>
        </article>`).join('');
    const closedRows = closed.map(a => `<div class="t-row t-row-sm"><span>${esc(a.item_name)}</span><span class="e-dim">${a.winner_name ? `won by ${esc(a.winner_name)} for ${a.winning_bid} ${esc(pts())}` : 'no bids'}</span></div>`).join('');
    return `<div class="p-section-head"><h3 class="t-h3" style="margin:0">Auctions</h3>${isOfficer() ? '<button class="btn btn-sm btn-secondary" data-action="addauction">+ Auction</button>' : ''}</div>
        ${openRows}${closedRows ? `<div class="t-h3">Closed</div>${closedRows}` : ''}${!auctions.length ? '<div class="t-empty-sub">No auctions yet.</div>' : ''}`;
}

function pointsHtml() {
    const mine = balances.find(b => b.user_id === me());
    return `
        <div class="timers-toolbar">
            <div class="timers-summary" style="margin:0">${balances.length} member${balances.length !== 1 ? 's' : ''} on the board${mine ? ` · you have <b class="${mine.balance >= 0 ? 't-ok' : ''}">${mine.balance} ${esc(pts())}</b>` : ''}</div>
            <div class="header-spacer"></div>
            ${isOfficer() ? `<button class="btn btn-primary" data-action="award">+ Award ${esc(pts())}</button>` : ''}
        </div>
        <div class="prows">${standingsHtml()}</div>
        <button class="e-past-toggle" data-action="togglehistory">${showHistory ? '▾' : '▸'} History (${history.length})</button>
        ${showHistory ? `<div class="p-history">${historyHtml()}</div>` : ''}
        <div class="p-section">${auctionsHtml()}</div>`;
}

// ---------------------------------------------------------------- actions

const ICON = {
    loot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-6 9 6v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 9h18M12 3v18"/></svg>',
    gavel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4l6 6-4 4-6-6z"/><path d="M12 10l-8 8 2 2 8-8"/><path d="M3 21h9"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

function onClick(ev) {
    const btn = ev.target.closest('[data-action]');
    if (!btn || !root()?.contains(btn)) return;
    const id = btn.dataset.id;
    switch (btn.dataset.action) {
        case 'upgrade': showUpgradeModal(); break;
        case 'addloot': openLootModal(); break;
        case 'took': openLootModal(id); break;
        case 'move': btn.closest('details.menu')?.removeAttribute('open'); moveMember(id, btn.dataset.to); break;
        case 'resetrotation': resetRotation(); break;
        case 'delloot': delLoot(id); break;
        case 'addwish': openWishModal(); break;
        case 'delwish': delWish(id); break;
        case 'award': openAwardModal(); break;
        case 'togglehistory': showHistory = !showHistory; render(); break;
        case 'addauction': openAuctionModal(); break;
        case 'bid': bid(id); break;
        case 'closeauction': closeAuction(id); break;
    }
}

const delLoot = guard('points.delloot', async (id) => {
    if (!(await confirmDialog('Remove this loot entry? Any points it deducted are not refunded.', { confirmLabel: 'Remove' }))) return;
    const res = await api('DELETE', `/api/teams/${currentTeamId}/loot/${id}`);
    if (res.error) { showToast(res.error); return; }
    await reload();
});
const moveMember = guard('points.move', async (id, to) => {
    const res = await api('POST', `/api/teams/${currentTeamId}/rotation/${id}`, { to });
    if (res.error) { showToast(res.error); return; }
    await reload();
});
const resetRotation = guard('points.resetrotation', async () => {
    if (!(await confirmDialog('Reset the rotation to join order? Every position is forgotten.', { confirmLabel: 'Reset' }))) return;
    const res = await api('POST', `/api/teams/${currentTeamId}/rotation/reset`);
    if (res.error) { showToast(res.error); return; }
    showToast('Rotation reset'); await reload();
});
const delWish = guard('points.delwish', async (id) => {
    const res = await api('DELETE', `/api/teams/${currentTeamId}/wishlist/${id}`);
    if (res.error) { showToast(res.error); return; }
    await reload();
});
const bid = guard('points.bid', async (id) => {
    const input = root().querySelector(`[data-bid="${id}"]`);
    const amount = parseInt(input?.value);
    if (!amount) { showToast('Enter a bid'); return; }
    const res = await api('POST', `/api/teams/${currentTeamId}/auctions/${id}/bid`, { amount });
    if (res.error) { showToast(res.error); return; }
    showToast('Bid placed'); await reload();
});
const closeAuction = guard('points.close', async (id) => {
    if (!(await confirmDialog('Close this auction? The top bidder is charged.', { confirmLabel: 'Close auction' }))) return;
    const res = await api('POST', `/api/teams/${currentTeamId}/auctions/${id}/close`);
    if (res.error) { showToast(res.error); return; }
    showToast('Auction closed'); await reload();
});

// ---------------------------------------------------------------- modals

function closeModal() { modalHost().innerHTML = ''; }
function modal(inner) {
    modalHost().innerHTML = `<div class="modal-backdrop" data-close="1"><div class="card modal-card">${inner}</div></div>`;
    const back = modalHost().firstElementChild;
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]:not(.modal-backdrop)')) closeModal(); });
    return back;
}
const memberOptions = (sel) => members().map(m => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.username)}</option>`).join('');
function formModal(title, fields, onSubmit, submitLabel = 'Save') {
    const back = modal(`<h2>${title}</h2><form class="tform" id="pForm">${fields}<div class="tf-actions tf-wide"><button type="button" class="btn btn-secondary" data-close="1">Cancel</button><button type="submit" class="btn btn-primary">${submitLabel}</button></div></form>`);
    const form = back.querySelector('#pForm');
    form.addEventListener('submit', async (e) => { e.preventDefault(); await onSubmit((id) => form.querySelector('#' + id)?.value); });
    setTimeout(() => form.querySelector('input,select')?.focus(), 0);
}

function openLootModal(recipientId) {
    const rotation = lootMode() === 'rotation';
    const who = recipientId || (rotation && order[0]?.id) || me();
    formModal('Log loot', `
        <label class="tf-field tf-wide"><span>Item</span><input id="plItem" required maxlength="100" placeholder="e.g. Sword of Destruction"></label>
        <label class="tf-field"><span>From boss <em>optional</em></span><input id="plBoss" maxlength="100" placeholder="e.g. Kundun"></label>
        <label class="tf-field"><span>Received by</span><select id="plWho">${memberOptions(who)}</select></label>
        ${rotation
            ? '<label class="tf-field tf-wide tf-check"><input type="checkbox" id="plRotate" checked> <span>Counts toward the rotation (moves them to the bottom)</span></label>'
            : `<label class="tf-field"><span>${esc(pts())} cost <em>0 = free</em></span><input id="plCost" type="number" min="0" value="0"></label>`}`,
        async (v) => {
            const itemName = v('plItem').trim(); if (!itemName) { showToast('Item name required'); return; }
            const keepPosition = rotation ? !modalHost().querySelector('#plRotate')?.checked : false;
            const res = await api('POST', `/api/teams/${currentTeamId}/loot`, { itemName, bossName: v('plBoss').trim() || 'Unknown', recipientId: v('plWho'), dkpCost: rotation ? 0 : (parseInt(v('plCost')) || 0), keepPosition });
            if (res.error) { showToast(res.error); return; }
            closeModal(); showToast('Loot logged'); await reload();
        }, 'Log loot');
}

function openWishModal() {
    formModal('Add to wishlist', `
        <label class="tf-field tf-wide"><span>Item</span><input id="pwItem" required maxlength="100" placeholder="e.g. Ring of Fire"></label>
        <label class="tf-field"><span>From boss <em>optional</em></span><input id="pwBoss" maxlength="100"></label>
        <label class="tf-field"><span>Priority</span><select id="pwPrio"><option value="1">Low</option><option value="2" selected>Medium</option><option value="3">High</option></select></label>`,
        async (v) => {
            const itemName = v('pwItem').trim(); if (!itemName) { showToast('Item name required'); return; }
            const res = await api('POST', `/api/teams/${currentTeamId}/wishlist`, { itemName, bossName: v('pwBoss').trim() || null, priority: parseInt(v('pwPrio')) || 1 });
            if (res.error) { showToast(res.error); return; }
            closeModal(); showToast('Added to wishlist'); await reload();
        }, 'Add');
}

function openAwardModal() {
    formModal(`Award ${esc(pts())}`, `
        <label class="tf-field tf-wide"><span>Member</span><select id="paWho"><option value="__all__">Everyone on the team</option>${memberOptions()}</select></label>
        <label class="tf-field"><span>Amount <em>negative to deduct</em></span><input id="paAmt" type="number" required placeholder="e.g. 10"></label>
        <label class="tf-field"><span>Reason</span><input id="paWhy" required maxlength="200" placeholder="e.g. Raid attendance"></label>`,
        async (v) => {
            const amount = parseInt(v('paAmt')); const reason = v('paWhy').trim();
            if (!amount || !reason) { showToast('Amount and reason required'); return; }
            const who = v('paWho');
            const res = who === '__all__'
                ? await api('POST', `/api/teams/${currentTeamId}/dkp/bulk`, { userIds: members().map(m => m.id), amount, reason })
                : await api('POST', `/api/teams/${currentTeamId}/dkp`, { userId: who, amount, reason });
            if (res.error) { showToast(res.error); return; }
            closeModal(); showToast(`${pts()} updated`); await reload();
        }, 'Apply');
}

function openAuctionModal() {
    formModal('Start an auction', `
        <label class="tf-field tf-wide"><span>Item</span><input id="pauItem" required maxlength="100"></label>
        <label class="tf-field"><span>Minimum bid</span><input id="pauMin" type="number" min="0" value="0"></label>
        <label class="tf-field"><span>Closes <em>optional</em></span><input id="pauEnd" type="datetime-local"></label>`,
        async (v) => {
            const itemName = v('pauItem').trim(); if (!itemName) { showToast('Item name required'); return; }
            const end = v('pauEnd') ? Math.floor(new Date(v('pauEnd')).getTime() / 1000) : null;
            const res = await api('POST', `/api/teams/${currentTeamId}/auctions`, { itemName, minBid: parseInt(v('pauMin')) || 0, expiresAt: end });
            if (res.error) { showToast(res.error); return; }
            closeModal(); showToast('Auction started'); await reload();
        }, 'Start');
}

window.Points = { open, refresh: reload };
