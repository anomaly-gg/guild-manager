// DKP ledger, history, bulk awards, auctions (protected routes)

import { json, safeJson } from '../lib/http.js';
import { requireTeamMember, isPremiumTeam } from '../lib/team.js';

export const routes = [
  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/dkp$/, handler: async ({ env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);

    // Get balances (sum of ledger per user)
    const balances = await env.DB.prepare(`
      SELECT dl.user_id, u.username, u.avatar, u.discord_id, SUM(dl.amount) as balance
      FROM dkp_ledger dl JOIN users u ON u.id = dl.user_id
      WHERE dl.team_id = ?
      GROUP BY dl.user_id
      ORDER BY balance DESC
    `).bind(teamId).all();

    return json({ balances: balances.results });
  } },

  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/dkp$/, handler: async ({ request, env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    if (!body.userId || body.amount === undefined || !body.reason?.trim()) return json({ error: 'User, amount, and reason required' }, 400);
    const dkpAmount = Number(body.amount);
    if (!Number.isFinite(dkpAmount) || dkpAmount === 0 || Math.abs(dkpAmount) > 999999) return json({ error: 'Invalid amount (max 999999)' }, 400);
    if (body.reason.trim().length > 200) return json({ error: 'Reason too long (max 200 chars)' }, 400);

    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO dkp_ledger (id, team_id, user_id, amount, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, teamId, body.userId, dkpAmount, body.reason.trim(), user.userId).run();

    return json({ ok: true, id });
  } },

  // GET /api/teams/:id/dkp/history — full ledger
  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/dkp\/history$/, handler: async ({ env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);

    const history = await env.DB.prepare(`
      SELECT dl.*, u.username, u2.username as created_by_name
      FROM dkp_ledger dl
      JOIN users u ON u.id = dl.user_id
      JOIN users u2 ON u2.id = dl.created_by
      WHERE dl.team_id = ?
      ORDER BY dl.created_at DESC
      LIMIT 100
    `).bind(teamId).all();

    return json({ history: history.results });
  } },

  // POST /api/teams/:id/dkp/bulk — award DKP to multiple members
  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/dkp\/bulk$/, handler: async ({ request, env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    // body.userIds = [...], body.amount, body.reason
    if (!body.userIds?.length || !body.amount || !body.reason?.trim()) return json({ error: 'Users, amount, and reason required' }, 400);

    for (const userId of body.userIds) {
      const id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO dkp_ledger (id, team_id, user_id, amount, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, teamId, userId, body.amount, body.reason.trim(), user.userId).run();
    }

    return json({ ok: true });
  } },

  { method: 'GET', pattern: /^\/api\/teams\/([^/]+)\/auctions$/, handler: async ({ env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);
    if (!(await isPremiumTeam(env, teamId))) return json({ error: 'Premium required', premiumRequired: true }, 403);

    const auctions = await env.DB.prepare(`
      SELECT da.*, u.username as started_by_name, w.username as winner_name,
        (SELECT MAX(amount) FROM dkp_bids WHERE auction_id = da.id) as top_bid,
        (SELECT COUNT(*) FROM dkp_bids WHERE auction_id = da.id) as bid_count
      FROM dkp_auctions da
      JOIN users u ON u.id = da.started_by
      LEFT JOIN users w ON w.id = da.winner_id
      WHERE da.team_id = ? ORDER BY da.status ASC, da.created_at DESC LIMIT 50
    `).bind(teamId).all();
    return json({ auctions: auctions.results });
  } },

  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/auctions$/, handler: async ({ request, env, user, params }) => {
    const teamId = params[1];
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);
    if (!(await isPremiumTeam(env, teamId))) return json({ error: 'Premium required', premiumRequired: true }, 403);

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    if (!body.itemName?.trim()) return json({ error: 'Item name required' }, 400);
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO dkp_auctions (id, team_id, item_name, boss_name, started_by, min_bid, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, teamId, body.itemName.trim(), body.bossName || null, user.userId, body.minBid || 0, body.expiresAt || null).run();
    return json({ ok: true, id });
  } },

  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/auctions\/([^/]+)\/bid$/, handler: async ({ request, env, user, params }) => {
    const [, teamId, auctionId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member) return json({ error: 'Not a member' }, 403);

    const auction = await env.DB.prepare('SELECT * FROM dkp_auctions WHERE id = ? AND team_id = ? AND status = ?')
      .bind(auctionId, teamId, 'open').first();
    if (!auction) return json({ error: 'Auction not found or closed' }, 404);
    // The cron closes expired auctions only every few minutes: no bids in between.
    if (auction.expires_at && auction.expires_at < Date.now() / 1000) return json({ error: 'Auction has ended' }, 400);

    const body = await safeJson(request);
    if (!body) return json({ error: "Invalid request body" }, 400);
    if (!body.amount || body.amount <= 0) return json({ error: 'Invalid bid' }, 400);
    if (body.amount < (auction.min_bid || 0)) return json({ error: `Minimum bid is ${auction.min_bid}` }, 400);

    // Check DKP balance
    const bal = await env.DB.prepare('SELECT COALESCE(SUM(amount),0) as balance FROM dkp_ledger WHERE team_id = ? AND user_id = ?')
      .bind(teamId, user.userId).first();
    if (bal.balance < body.amount) return json({ error: 'Not enough DKP' }, 400);

    // Check higher bid exists
    const topBid = await env.DB.prepare('SELECT MAX(amount) as top FROM dkp_bids WHERE auction_id = ?').bind(auctionId).first();
    if (topBid.top && body.amount <= topBid.top) return json({ error: `Must bid higher than ${topBid.top}` }, 400);

    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO dkp_bids (id, auction_id, user_id, amount) VALUES (?, ?, ?, ?)')
      .bind(id, auctionId, user.userId, body.amount).run();
    return json({ ok: true });
  } },

  { method: 'POST', pattern: /^\/api\/teams\/([^/]+)\/auctions\/([^/]+)\/close$/, handler: async ({ env, user, params }) => {
    const [, teamId, auctionId] = params;
    const member = await requireTeamMember(env, teamId, user.userId);
    if (!member || member.role === 'member') return json({ error: 'Officers+ only' }, 403);

    const auction = await env.DB.prepare('SELECT * FROM dkp_auctions WHERE id = ? AND team_id = ? AND status = ?')
      .bind(auctionId, teamId, 'open').first();
    if (!auction) return json({ error: 'Auction not found or already closed' }, 404);

    const topBid = await env.DB.prepare('SELECT * FROM dkp_bids WHERE auction_id = ? ORDER BY amount DESC LIMIT 1')
      .bind(auctionId).first();

    if (topBid) {
      // Deduct DKP from winner
      const dkpId = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO dkp_ledger (id, team_id, user_id, amount, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(dkpId, teamId, topBid.user_id, -topBid.amount, `Auction: ${auction.item_name}`, user.userId).run();
      await env.DB.prepare('UPDATE dkp_auctions SET status = ?, winner_id = ?, winning_bid = ? WHERE id = ?')
        .bind('closed', topBid.user_id, topBid.amount, auctionId).run();
    } else {
      await env.DB.prepare('UPDATE dkp_auctions SET status = ? WHERE id = ?').bind('closed', auctionId).run();
    }
    return json({ ok: true, winner: topBid?.user_id || null });
  } },
];
