// Guild Manager - Cloudflare Worker entry point.
// Bindings: DB (D1), FILES (R2); secrets: DISCORD_*, GOOGLE_*, JWT_SECRET, DISCORD_BOT_TOKEN; vars: GUMROAD_*, DISCORD_APP_ID/PUBLIC_KEY (wrangler.toml).
import { handleRequest } from './router.js';
import { handleScheduled } from './cron/scheduled.js';
import { corsHeaders } from './lib/http.js';

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch(e) {
      console.error('Unhandled error:', e);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env, event.scheduledTime));
  },
};
