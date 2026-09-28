"""Mock of Gumroad's license verify API for local worker tests.
POST /v2/licenses/verify (form)  -> like Gumroad
POST /__set  {"key": ..., "purchase": {...}} -> replace a key's purchase; {"fail": true} -> return 500s
"""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

PROD_M, PROD_L = 'vbeeit', 'gm-lifetime'
LONG = {'vbeeit': 'AbCdEfGhIjKlMnOpQrStUvWxYz012345==', 'gm-lifetime': 'ZyXwVuTsRqPoNmLkJiHgFeDcBa543210=='}
BASE = {'refunded': False, 'chargebacked': False, 'subscription_ended_at': None,
        'subscription_cancelled_at': None, 'subscription_failed_at': None, 'email': 'buyer@example.com', 'test': True}
STATE = {
    'fail': False,
    'keys': {
        'GOOD-MONTHLY-0001': {'product_id': PROD_M, **BASE},
        'GOOD-LIFE-0001':    {'product_id': PROD_L, **BASE},
        'GOOD-MONTHLY-0002': {'product_id': PROD_M, **BASE},
        'ENDED-MONTHLY-0001': {'product_id': PROD_M, **BASE, 'subscription_ended_at': '2026-09-01T00:00:00Z'},
        'REFUND-LIFE-0001':  {'product_id': PROD_L, **BASE, 'refunded': True},
    },
}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0); raw = self.rfile.read(n)
        if self.path == '/__set':
            d = json.loads(raw or b'{}')
            if 'fail' in d: STATE['fail'] = bool(d['fail'])
            if 'key' in d: STATE['keys'][d['key']] = d['purchase']
            return self._send(200, {'ok': True})
        if self.path == '/v2/licenses/verify':
            if STATE['fail']: return self._send(500, {'success': False, 'message': 'boom'})
            f = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
            p = STATE['keys'].get(f.get('license_key', ''))
            want = f.get('product_permalink') or next((k for k, v in LONG.items() if v == f.get('product_id')), None)
            if not p or p['product_id'] != want:
                return self._send(404, {'success': False, 'message': 'That license does not exist for the provided product.'})
            return self._send(200, {'success': True, 'uses': 1, 'purchase': {**p, 'license_key': f['license_key']}})
        self._send(404, {'error': 'nope'})

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
