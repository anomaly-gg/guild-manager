"""M11 account export + deletion test against `wrangler dev --local` (port 8788)."""
import json, sys, urllib.request, urllib.error, urllib.parse

W = 'http://127.0.0.1:8788'
checks = []

def req(method, path, body=None, token=None):
    data = None; headers = {}
    if body is not None: data = json.dumps(body).encode(); headers['Content-Type'] = 'application/json'
    if token: headers['Authorization'] = 'Bearer ' + token
    r = urllib.request.Request(W + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read()
            try: return resp.status, json.loads(raw or b'{}')
            except Exception: return resp.status, {'raw': raw.decode(errors='replace')}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, {'raw': raw.decode(errors='replace')}

def check(name, cond, info=''):
    checks.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else f'   <- {info}'))

def guest(name):
    s, d = req('POST', '/auth/guest', {'username': name}); return d['token']
def me(tok): return req('GET', '/auth/me', token=tok)

alice = guest('alice_del'); bob = guest('bob_stays')
# alice leads team A (bob joins), alice also leads solo team B
s, d = req('POST', '/api/teams', {'name': 'Team A'}, alice); teamA = d.get('id') or d.get('team', {}).get('id')
s, d = req('GET', f'/api/teams/{teamA}', token=alice); code = (d.get('team') or d).get('invite_code')
req('POST', f'/api/invite/{code}', {}, bob)
# alice is free: cap is 1 team she leads — make her premium in-DB is heavy; instead bob leads team B and alice joins it
s, d = req('POST', '/api/teams', {'name': 'Team B'}, bob); teamB = d.get('id') or d.get('team', {}).get('id')
s, d = req('GET', f'/api/teams/{teamB}', token=bob); codeB = (d.get('team') or d).get('invite_code')
req('POST', f'/api/invite/{codeB}', {}, alice)
# alice creates an event in team B and RSVPs; adds a boss in team A
s, d = req('POST', f'/api/teams/{teamB}/events', {'title': 'Raid night', 'eventTime': 4102444800000, 'eventType': 'raid'}, alice)
eventB = d.get('id') or (d.get('event') or {}).get('id')
check('alice created an event in team B', s == 200 and eventB, d)
req('POST', f'/api/teams/{teamB}/events/{eventB}/rsvp', {'status': 'going', 'role': 'DPS'}, alice)
req('POST', f'/api/teams/{teamA}/bosses', {'name': 'Venatus', 'type': 'interval', 'intervalMs': 36000000}, alice)

# export
s, d = req('GET', '/api/me/export', token=alice)
check('export returns profile + memberships + led teams', s == 200 and d.get('profile', {}).get('username') == 'alice_del' and len(d.get('memberships', [])) == 2 and len(d.get('teamsYouLead', [])) == 1, {k: (len(v) if isinstance(v, list) else v) for k, v in d.items()} if isinstance(d, dict) else d)
led = d['teamsYouLead'][0]
check('led team dump has members and bosses', len(led['members']) == 2 and len(led['bosses']) == 1, {k: len(v) if isinstance(v, list) else 1 for k, v in led.items()})
s, d = req('GET', '/api/me/export?token=' + urllib.parse.quote(alice, safe=''))
check('export works with ?token= (new tab download)', s == 200 and d.get('profile'), s)

# delete refused while leading team A with bob in it
s, d = req('DELETE', '/api/me', token=alice)
check('delete refused while leading a team with other members', s == 409 and d.get('teams') and d['teams'][0]['name'] == 'Team A', d)

# transfer A to bob, then delete
# find bob's id via team detail
s, d = req('GET', f'/api/teams/{teamA}', token=alice)
members = (d.get('members') or (d.get('team') or {}).get('members') or [])
bob_id = next((m.get('user_id') or m.get('id') for m in members if (m.get('username') == 'bob_stays')), None)
s, d = req('POST', f'/api/teams/{teamA}/transfer', {'userId': bob_id}, alice)
check('leadership transferred to bob', s == 200 and not d.get('error'), d)

s, d = req('DELETE', '/api/me', token=alice)
check('delete succeeds after transfer', s == 200 and d.get('ok'), d)
s, d = me(alice)
check('stale token now gets 401', s == 401, (s, d))
s, d = req('POST', '/api/teams', {'name': 'Zombie'}, alice)
check('stale token cannot create a team', s == 401, (s, d))
s, d = req('POST', f'/api/invite/{codeB}', {}, alice)
check('stale token cannot join a team', s == 401, (s, d))

# bob's view: alice gone from rosters, her event remains attributed to Deleted user
s, d = req('GET', f'/api/teams/{teamA}', token=bob)
names = [m.get('username') for m in (d.get('members') or (d.get('team') or {}).get('members') or [])]
check('alice removed from team A roster', 'alice_del' not in names and 'bob_stays' in names, names)
s, d = req('GET', f'/api/teams/{teamB}/events', token=bob)
evs = d.get('events', d if isinstance(d, list) else [])
ev = next((e for e in evs if e.get('id') == eventB), None)
check('her event in team B still exists', ev is not None, [e.get('title') for e in evs])
creator = (ev or {}).get('creator_name') or (ev or {}).get('created_by_name') or ''
check('event creator shows as Deleted user (or name field absent)', creator in ('', 'Deleted user'), creator)
rsvps = (ev or {}).get('rsvps') or []
check('her RSVP is gone', not any((r.get('username') == 'alice_del') for r in rsvps), rsvps)

n = sum(checks); print(f'\n{n}/{len(checks)} checks passed'); sys.exit(0 if n == len(checks) else 1)
