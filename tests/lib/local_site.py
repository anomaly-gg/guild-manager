"""Same-origin test harness: serves guild-manager's static files on :8790 with the API base rewritten
to this origin, and proxies /api, /auth, /discord, /public, /gumroad to wrangler dev on :8788.
Used by the browser tests; tests/run_all.mjs starts and stops it."""
import http.server, urllib.request, os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UP = 'http://127.0.0.1:8788'
PROD = b'https://guild-manager.xpropics.workers.dev'
PROXY = ('/api/', '/auth/', '/discord/', '/public/', '/gumroad/')


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _proxy(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else None
        req = urllib.request.Request(UP + self.path, data=body, method=self.command,
                                     headers={k: v for k, v in self.headers.items() if k.lower() not in ('host', 'content-length', 'accept-encoding', 'connection')})
        try:
            r = urllib.request.urlopen(req)
            code, data, hdrs = r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            code, data, hdrs = e.code, e.read(), e.headers
        self.send_response(code)
        for k, v in hdrs.items():
            if k.lower() in ('content-type', 'location'):
                self.send_header(k, v)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _route(self):
        if self.path.startswith(PROXY):
            return self._proxy()
        path = self.path.split('?')[0]
        if path.endswith(('.js', '.html')) or path == '/':
            f = os.path.join(ROOT, 'index.html' if path == '/' else path.lstrip('/'))
            if os.path.isfile(f):
                data = open(f, 'rb').read().replace(PROD, b'http://127.0.0.1:8790')
                self.send_response(200)
                self.send_header('Content-Type', 'text/javascript' if path.endswith('.js') else 'text/html')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        return super().do_GET() if self.command == 'GET' else self.send_error(404)

    do_GET = do_POST = do_PUT = do_DELETE = _route


http.server.ThreadingHTTPServer(('127.0.0.1', 8790), H).serve_forever()
