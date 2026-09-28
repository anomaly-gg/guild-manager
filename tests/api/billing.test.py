"""M9 billing API test against `wrangler dev --local --test-scheduled` (port 8788) + mock_gumroad.py (8799)."""
import json, subprocess, sys, time, urllib.request, urllib.parse, urllib.error

W = 'http://127.0.0.1:8788'
MOCK = 'http://127.0.0.1:8799'
PROD_M, PROD_L = 'vbeeit', 'gm-lifetime'
LONG = {'vbeeit': 'AbCdEfGhIjKlMnOpQrStUvWxYz012345==', 'gm-lifetime': 'ZyXwVuTsRqPoNmLkJiHgFeDcBa543210=='}
def pingfields(p): return {'product_id': LONG[p], 'permalink': p, 'product_permalink': 'https://anomalyftw.gumroad.com/l/' + p, 'short_product_id': p}
checks = []

def req(method, path, body=None, token=None, form=False, base=W):
    data = None; headers = {}
    if body is not None:
        if form: data = urllib.parse.urlencode(body).encode(); headers['Content-Type'] = 'application/x-www-form-urlencoded'
        else: data = json.dumps(body).encode(); headers['Content-Type'] = 'application/json'
    if token: headers['Authorization'] = 'Bearer ' + token
    r = urllib.request.Request(base + path, data=data, method=method, headers=headers)
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
    checks.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else f'   <- {info}'))

def guest(name):
    s, d = req('POST', '/auth/guest', {'username': name}); tok = d.get('token')
    s, me = req('GET', '/auth/me', token=tok)
    return tok, me['id']

def me(tok):
    return req('GET', '/auth/me', token=tok)[1]

def set_mock(**kw):
    req('POST', '/__set', kw, base=MOCK)

t1, u1 = guest('buyer_one'); t2, u2 = guest('buyer_two'); t3, u3 = guest('buyer_three')

# checkout link
s, d = req('POST', '/api/checkout', {'type': 'lifetime'}, token=t1)
check('checkout returns lifetime url with uid + wanted', s == 200 and 'uid=' + u1 in d.get('url', '') and 'wanted=true' in d['url'] and 'lifetime' in d['url'], d)
s, d = req('POST', '/api/checkout', {'type': 'monthly'}, token=t1)
check('checkout returns monthly url', s == 200 and 'monthly' in d.get('url', ''), d)
s, d = req('POST', '/api/checkout', {'type': 'monthly'})
check('checkout needs login', s == 401, d)

# manual activation
s, d = req('POST', '/api/activate-license', {'licenseKey': 'nope'}, token=t1)
check('activate rejects malformed key', s == 400, d)
s, d = req('POST', '/api/activate-license', {'licenseKey': 'ZZZZ-ZZZZ-ZZZZ-0000'}, token=t1)
check('activate rejects unknown key', s == 400 and ('not found' in d.get('error', '').lower() or 'does not exist' in d.get('error', '')), d)
s, d = req('POST', '/api/activate-license', {'licenseKey': 'ended-monthly-0001'}, token=t1)
check('activate rejects ended membership (case-insensitive key)', s == 400 and 'ended' in d.get('error', ''), d)
s, d = req('POST', '/api/activate-license', {'licenseKey': 'REFUND-LIFE-0001'}, token=t1)
check('activate rejects refunded purchase', s == 400 and 'refunded' in d.get('error', ''), d)
s, d = req('POST', '/api/activate-license', {'licenseKey': 'GOOD-MONTHLY-0001'}, token=t1)
check('activate monthly key ok', s == 200 and d.get('plan') == 'monthly', d)
m = me(t1)
check('user1 is premium monthly', m['premium'] and m['premiumType'] == 'monthly' and not m['trial'], m)
s, d = req('POST', '/api/activate-license', {'licenseKey': 'GOOD-MONTHLY-0001'}, token=t2)
check('same key on another account refused', s == 400 and 'another account' in d.get('error', ''), d)
s, d = req('POST', '/api/activate-license', {'licenseKey': 'GOOD-MONTHLY-0001'}, token=t1)
check('re-activating own key is fine', s == 200, d)

# ping webhook
s, d = req('POST', '/gumroad/ping', {'license_key': 'GOOD-LIFE-0001', **pingfields(PROD_L), 'url_params[uid]': u2, 'sale_id': 'x1', 'email': 'buyer@example.com'}, form=True)
check('ping with uid is acknowledged', s == 200 and d.get('ok'), d); time.sleep(1.5)
m = me(t2)
check('user2 is premium lifetime', m['premium'] and m['premiumType'] == 'lifetime', m)
s, d = req('POST', '/api/activate-license', {'licenseKey': 'GOOD-MONTHLY-0002'}, token=t2)
check('a monthly key cannot downgrade an active lifetime account', s == 400 and 'Lifetime' in d.get('error', '') and me(t2)['premiumType'] == 'lifetime', d)
s, d = req('POST', '/gumroad/ping', {'license_key': 'GOOD-MONTHLY-0001', **pingfields(PROD_M), 'sale_id': 'x2'}, form=True)
time.sleep(1.5); check('ping without uid keeps the account that holds the key premium', s == 200 and me(t1)['premium'] and me(t1)['premiumType'] == 'monthly', d)
s, d = req('POST', '/gumroad/ping', {'license_key': 'NEW-KEY-9999', **pingfields(PROD_M)}, form=True)
check('ping for unknown account is ignored with 200', s == 200 and d.get('ignored'), d)
s, d = req('POST', '/gumroad/ping', {'license_key': 'GOOD-LIFE-0001', 'product_id': 'some_other_product', 'url_params[uid]': u3}, form=True)
check('ping for a non-premium product is ignored', s == 200 and d.get('ignored'), d)
s, d = req('POST', '/gumroad/ping', {'license_key': 'GOOD-LIFE-0001', **pingfields(PROD_L), 'url_params[uid]': u3}, form=True)
time.sleep(1.5); check('ping trying to bind a taken key to a 3rd account is refused (user3 still free)', s == 200 and not me(t3)['premium'], me(t3))
s, d = req('POST', '/gumroad/ping', {'license_key': 'FAKE-0000-0000-0000', **pingfields(PROD_L), 'url_params[uid]': u3}, form=True)
time.sleep(1.5); check('forged ping with unverifiable key grants nothing', s == 200 and not me(t3)['premium'], d)

# Gumroad down -> transient
set_mock(fail=True)
s, d = req('POST', '/api/activate-license', {'licenseKey': 'GOOD-LIFE-0001'}, token=t3)
check('activate returns 503 when Gumroad is down', s == 503, d)
s, d = req('POST', '/gumroad/ping', {'license_key': 'GOOD-LIFE-0001', **pingfields(PROD_L), 'url_params[uid]': u2}, form=True)
time.sleep(1.5); check('ping while Gumroad is down is acked and changes nothing', s == 200 and me(t2)['premiumType'] == 'lifetime', d)
set_mock(fail=False)

# recheck via cron: force checks due, end user1's membership at Gumroad
subprocess.run(['npx', 'wrangler', 'd1', 'execute', 'guild-manager', '--local', '--command', 'UPDATE users SET license_checked_at = 0'],
               cwd=sys.argv[1], shell=True, capture_output=True)
set_mock(key='GOOD-MONTHLY-0001', purchase={'product_id': PROD_M, 'refunded': False, 'chargebacked': False, 'subscription_ended_at': None,
                                            'subscription_cancelled_at': '2026-09-22T00:00:00Z', 'subscription_failed_at': None, 'email': 'b@e.com', 'test': True})
s, d = req('GET', '/__scheduled'); time.sleep(3)
check('cron ran', s == 200, (s, d))
check('recheck revoked user1 (membership cancelled at Gumroad)', not me(t1)['premium'], me(t1))
check('recheck kept user2 lifetime', me(t2)['premium'] and me(t2)['premiumType'] == 'lifetime', me(t2))
# membership restarted -> next recheck re-grants
set_mock(key='GOOD-MONTHLY-0001', purchase={'product_id': PROD_M, 'refunded': False, 'chargebacked': False, 'subscription_ended_at': None,
                                            'subscription_cancelled_at': None, 'subscription_failed_at': None, 'email': 'b@e.com', 'test': True})
subprocess.run(['npx', 'wrangler', 'd1', 'execute', 'guild-manager', '--local', '--command', 'UPDATE users SET license_checked_at = 0'],
               cwd=sys.argv[1], shell=True, capture_output=True)
req('GET', '/__scheduled'); time.sleep(3)
check('recheck re-grants a restarted membership', me(t1)['premium'] and me(t1)['premiumType'] == 'monthly', me(t1))

# trial still works
s, d = req('POST', '/api/start-trial', token=t3)
check('guest cannot start trial', s == 400, d)

n = sum(1 for _, ok in checks if ok)
print(f'\n{n}/{len(checks)} checks passed')
sys.exit(0 if n == len(checks) else 1)
