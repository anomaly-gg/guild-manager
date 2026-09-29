// Login flows: Discord OAuth, Google OAuth, guest accounts, /auth/me (public routes)

import { json, sanitizeStr } from '../lib/http.js';
import { createToken, getUser } from '../lib/auth.js';

export const routes = [
  // GET /auth/login — redirect to Discord OAuth
  { method: '*', pattern: '/auth/login', handler: async ({ env, url }) => {
    const redirect = `https://discord.com/api/oauth2/authorize?client_id=${env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(url.origin + '/auth/callback')}&response_type=code&scope=identify`;
    return Response.redirect(redirect, 302);
  } },

  // GET /auth/callback — Discord OAuth callback
  { method: '*', pattern: '/auth/callback', handler: async ({ env, url }) => {
    const code = url.searchParams.get('code');
    if (!code) return json({ error: 'No code provided' }, 400);

    // Exchange code for token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: url.origin + '/auth/callback',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return json({ error: 'OAuth failed' }, 400);

    // Get Discord user info
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json();
    if (!discordUser.id) return json({ error: 'Failed to get user' }, 400);

    // Upsert user in DB
    const userId = crypto.randomUUID();
    const existing = await env.DB.prepare('SELECT id FROM users WHERE discord_id = ?').bind(discordUser.id).first();

    let finalUserId;
    const safeName = sanitizeStr(discordUser.username);
    if (existing) {
      finalUserId = existing.id;
      await env.DB.prepare('UPDATE users SET username = ?, avatar = ? WHERE id = ?')
        .bind(safeName, discordUser.avatar, existing.id).run();
    } else {
      finalUserId = userId;
      await env.DB.prepare('INSERT INTO users (id, discord_id, username, avatar) VALUES (?, ?, ?, ?)')
        .bind(userId, discordUser.id, safeName, discordUser.avatar).run();
    }

    // Create JWT
    const jwt = await createToken({
      userId: finalUserId,
      discordId: discordUser.id,
      username: discordUser.username,
    }, env.JWT_SECRET);

    // Redirect to frontend with token
    const frontendUrl = 'https://anomaly-gg.github.io/guild-manager';
    return Response.redirect(`${frontendUrl}?token=${encodeURIComponent(jwt)}`, 302);
  } },

  // GET /auth/google — redirect to Google OAuth
  { method: '*', pattern: '/auth/google', handler: async ({ env, url }) => {
    const redirect = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(url.origin + '/auth/google/callback')}&response_type=code&scope=openid%20profile&prompt=select_account`;
    return Response.redirect(redirect, 302);
  } },

  // GET /auth/google/callback
  { method: '*', pattern: '/auth/google/callback', handler: async ({ env, url }) => {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const frontendUrl = 'https://anomaly-gg.github.io/guild-manager';
    if (error || !code) return Response.redirect(frontendUrl, 302);

    try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: url.origin + '/auth/google/callback',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return Response.redirect(frontendUrl, 302);

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const googleUser = await userRes.json();
    if (!googleUser.id) return json({ error: 'Failed to get Google user' }, 400);

    const existing = await env.DB.prepare('SELECT id FROM users WHERE google_id = ?').bind(googleUser.id).first();
    let finalUserId;

    const googleName = sanitizeStr(googleUser.name || googleUser.email);
    if (existing) {
      finalUserId = existing.id;
      await env.DB.prepare('UPDATE users SET username = ?, avatar = ? WHERE id = ?')
        .bind(googleName, googleUser.picture || null, existing.id).run();
    } else {
      finalUserId = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO users (id, google_id, discord_id, username, avatar, auth_type) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(finalUserId, googleUser.id, 'google_' + googleUser.id, googleName, googleUser.picture || null, 'google').run();
    }

    const jwt = await createToken({ userId: finalUserId, username: googleName }, env.JWT_SECRET);
    return Response.redirect(`${frontendUrl}?token=${encodeURIComponent(jwt)}`, 302);
    } catch(e) {
      console.error('Google auth error:', e);
      return Response.redirect(frontendUrl, 302);
    }
  } },

  // POST /auth/guest — create guest account
  { method: 'POST', pattern: '/auth/guest', handler: async ({ request, env }) => {
    const body = await request.json().catch(() => ({}));
    const username = body.username?.trim();
    if (!username || username.length < 2 || username.length > 20 || !/^[a-zA-Z0-9_\- ]+$/.test(username)) {
      return json({ error: 'Username must be 2-20 characters (letters, numbers, underscore, dash)' }, 400);
    }

    const userId = crypto.randomUUID();
    const guestId = 'guest_' + userId.slice(0, 8);

    await env.DB.prepare('INSERT INTO users (id, discord_id, username, auth_type) VALUES (?, ?, ?, ?)')
      .bind(userId, guestId, username, 'guest').run();

    const jwt = await createToken({ userId, username }, env.JWT_SECRET);
    return json({ token: jwt });
  } },

  // GET /auth/me — get current user
  { method: '*', pattern: '/auth/me', handler: async ({ request, env }) => {
    const user = await getUser(request, env);
    if (!user) return json({ error: 'Not logged in' }, 401);
    const dbUser = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.userId).first();
    if (!dbUser) return json({ error: 'User not found' }, 404);
    if (dbUser.auth_type === 'deleted') return json({ error: 'Account deleted' }, 401);   // stale token after DELETE /api/me
    // Check if subscription is still active
    let isPremium = false;
    let isTrial = false;
    let trialDaysLeft = 0;
    if (dbUser.premium) {
      if (String(dbUser.premium_type).trim().toLowerCase() === 'lifetime') {
        isPremium = true;
      } else if (dbUser.premium_until && dbUser.premium_until > Math.floor(Date.now() / 1000)) {
        isPremium = true;
      } else if (!dbUser.premium_type && !dbUser.premium_until) {
        isPremium = true;
      } else {
        await env.DB.prepare('UPDATE users SET premium = 0 WHERE id = ?').bind(dbUser.id).run();
      }
    }

    // Check free trial
    if (!isPremium && dbUser.trial_started) {
      const trialEnd = dbUser.trial_started + 7 * 86400;
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec < trialEnd) {
        isPremium = true;
        isTrial = true;
        trialDaysLeft = Math.ceil((trialEnd - nowSec) / 86400);
      } else if (!dbUser.trial_used) {
        await env.DB.prepare('UPDATE users SET trial_used = 1 WHERE id = ?').bind(dbUser.id).run();
      }
    }

    return json({
      id: dbUser.id,
      username: dbUser.username,
      avatar: dbUser.avatar,
      discordId: dbUser.discord_id,
      premium: isPremium,
      premiumType: isPremium ? (isTrial ? 'trial' : dbUser.premium_type) : null,
      trial: isTrial,
      trialDaysLeft: isTrial ? trialDaysLeft : 0,
      trialUsed: !!(dbUser.trial_used || dbUser.trial_started),
      authType: dbUser.auth_type || 'discord',
    });
  } },
];
