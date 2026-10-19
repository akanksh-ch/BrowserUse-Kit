"""Focused gateway checks; no OCI resources, public listeners, or ACME requests.
Run: CADDY=/path/to/caddy python3 tests/deployment.test.py -v
"""
import http.client
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
CADDY = shutil.which(os.environ.get('CADDY', 'caddy'))


class DeploymentDefaults(unittest.TestCase):
    def test_loopback_secure_and_exact_hosts(self):
        env = dict(line.split('=', 1) for line in (ROOT / 'deploy/buk.env').read_text().splitlines()
                   if line and not line.startswith('#'))
        self.assertEqual(env['BUK_BIND'], '127.0.0.1')
        self.assertEqual(env['BUK_SECURE'], '1')
        self.assertEqual(env['BUK_HOSTS'], 'buk.example.com,buk.example.com:443')
        config = (ROOT / 'deploy/Caddyfile').read_text()
        self.assertIn('reverse_proxy 127.0.0.1:3000', config)
        self.assertNotIn('header_up Host', config)
        self.assertIn('flush_interval -1', config)


@unittest.skipUnless(CADDY and shutil.which('openssl'), 'Caddy and openssl required; live TLS checks NOT RUN')
class GatewayTLS(unittest.TestCase):
    def test_parser_tls_authority_and_streaming(self):
        subprocess.run(['sh', 'deploy/check.sh'], cwd=ROOT,
                       env={**os.environ, 'CADDY': CADDY}, check=True, capture_output=True)
        observed = []

        class Upstream(BaseHTTPRequestHandler):
            def do_GET(self):
                observed.append((self.headers.get('Host'), self.headers.get('Authorization'),
                                 self.headers.get('Mcp-Session-Id'), self.headers.get('MCP-Protocol-Version')))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Mcp-Session-Id', 'session-result')
                self.end_headers()
                self.wfile.write(b'data: ready\n\n')
                self.wfile.flush()
                # Must receive this event before upstream finishes, not after buffering.
                self.server.release.wait(4)

            def log_message(self, *_args):
                pass

        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        upstream.release = threading.Event()
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        try:
            with tempfile.TemporaryDirectory(prefix='buk-deploy-tls-') as directory:
                directory = Path(directory)
                cert, key = directory / 'cert.pem', directory / 'key.pem'
                subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                                '-keyout', str(key), '-out', str(cert), '-days', '1',
                                '-subj', '/CN=buk.example.com', '-addext',
                                'subjectAltName=DNS:buk.example.com'], check=True, capture_output=True)
                config = (ROOT / 'deploy/Caddyfile').read_text()
                config = config.replace('https:// {', f'https://:{port} {{\n\tbind 127.0.0.1\n\ttls {cert} {key}', 1)
                config = config.replace('buk.example.com {', f'https://buk.example.com:{port} {{', 1)
                config = config.replace('127.0.0.1:3000', f'127.0.0.1:{upstream.server_port}')
                config = config.replace('\n\t# Reject', f'\n\tbind 127.0.0.1\n\ttls {cert} {key}\n\t# Reject', 1)
                config = '{\n admin off\n auto_https off\n}\n' + config
                path = directory / 'Caddyfile'
                path.write_text(config)
                with (directory / 'caddy.log').open('w+') as log:
                    process = subprocess.Popen([CADDY, 'run', '--config', str(path), '--adapter', 'caddyfile'],
                                               stdout=log, stderr=log)
                    try:
                        deadline = time.monotonic() + 10
                        while True:
                            try:
                                with socket.create_connection(('127.0.0.1', port), timeout=.2):
                                    break
                            except OSError:
                                if process.poll() is not None or time.monotonic() > deadline:
                                    log.seek(0)
                                    self.fail(log.read())
                                time.sleep(.05)
                        context = ssl.create_default_context(cafile=str(cert))
                        for authority in ('buk.example.com', 'buk.example.com:443',
                                          'attacker.invalid', 'buk.example.com:444', 'localhost'):
                            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
                            connection.sock = context.wrap_socket(socket.create_connection(('127.0.0.1', port)),
                                                                  server_hostname='buk.example.com')
                            try:
                                connection.request('GET', '/api/workspaces/w/mcp', headers={
                                    'Host': authority, 'Authorization': 'Bearer synthetic-test-only',
                                    'Mcp-Session-Id': 'session-test', 'MCP-Protocol-Version': '2025-03-26'})
                                response = connection.getresponse()
                                if authority in ('buk.example.com', 'buk.example.com:443'):
                                    self.assertEqual(response.status, 200)
                                    self.assertEqual(response.getheader('Mcp-Session-Id'), 'session-result')
                                    start = time.monotonic()
                                    self.assertEqual(response.readline(), b'data: ready\n')
                                    self.assertLess(time.monotonic() - start, 2)
                                    self.assertEqual(observed[-1], (authority, 'Bearer synthetic-test-only',
                                                                   'session-test', '2025-03-26'))
                                else:
                                    self.assertEqual(response.status, 421, authority)
                            finally:
                                connection.close()
                        self.assertEqual(len(observed), 2, 'unexpected Host reached upstream')
                    finally:
                        upstream.release.set()
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
        finally:
            upstream.release.set()
            upstream.shutdown()
            upstream.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
