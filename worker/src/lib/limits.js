// Plan limits. One place to change what Free and Premium allow (see OVERHAUL.md → Premium).

export const PLANS = {
  free:    { teams: 1,        members: 10,  timers: 15,       webhooks: 1 },
  premium: { teams: Infinity, members: 100, timers: Infinity, webhooks: 3 },   // webhooks = Discord channels per alert
};

export function limitsFor(premium) {
  return premium ? PLANS.premium : PLANS.free;
}

// JSON-safe copy for API responses (Infinity → null).
export function limitsJson(premium) {
  const l = limitsFor(premium);
  return { teams: Number.isFinite(l.teams) ? l.teams : null, members: l.members, timers: Number.isFinite(l.timers) ? l.timers : null, webhooks: l.webhooks };
}
