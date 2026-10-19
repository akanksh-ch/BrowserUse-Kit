"""HTTP/CONNECT policy proxy. Resolve once, validate ALL answers, connect by IP."""
import http.server
import ipaddress
import os

DENIED = tuple(ipaddress.ip_network(value) for value in os.environ.get('DENY_CIDRS', '').split(',') if value)
import select
import socket
import socketserver
import urllib.parse


def resolve(host, port):
    if port not in (80, 443):
        raise ValueError('port denied')
    answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not answers or any(not allowed(a[4][0]) for a in answers):
        raise ValueError('destination denied')
    return answers


def allowed(address):
    ip = ipaddress.ip_address(address)
    if any(ip.version == network.version and ip in network for network in DENIED):
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        # Deny transition mechanisms that can encapsulate private IPv4.
        if ip.ipv4_mapped or ip.sixtofour or ip.teredo or ip in ipaddress.ip_network('64:ff9b::/96'):
            return False
    return ip.is_global and not ip.is_multicast


def connect(host, port):
    answers = resolve(host, port)
    last = None
    for family, kind, proto, _, addr in answers:
        s = socket.socket(family, kind, proto)
        s.settimeout(15)
        try:
            s.connect(addr)
            return s
        except OSError as exc:
            last = exc
            s.close()
    raise OSError('upstream unavailable') from last


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    # Avoid buffered read-ahead swallowing tunnel bytes.
    rbufsize = 0

    def log_message(self, *_):
        pass  # No URLs, headers or credentials in logs.

    def do_CONNECT(self):
        self.forward(True)

    def do_GET(self):
        self.forward(False)

    do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = do_GET

    def forward(self, tunnel):
        self.close_connection = True
        try:
            url = urllib.parse.urlsplit(('//' if tunnel else '') + self.path)
            if url.username or url.password or not url.hostname:
                raise ValueError('invalid authority')
            if not tunnel and url.scheme != 'http':
                raise ValueError('scheme denied')
            port = url.port or (443 if tunnel else 80)
            upstream = connect(url.hostname, port)
        except (ValueError, OSError):
            print('network_policy_denial_or_resolution_failure', flush=True)
            self.send_error(403, 'Destination denied or unavailable')
            return
        with upstream:
            if tunnel:
                self.send_response(200, 'Connection Established')
                self.end_headers()
            else:
                path = urllib.parse.urlunsplit(('', '', url.path or '/', url.query, ''))
                authority = url.netloc
                headers = ''.join(f'{k}: {v}\r\n' for k, v in self.headers.items()
                                  if k.lower() not in ('host', 'connection', 'proxy-connection', 'proxy-authorization'))
                upstream.sendall(f'{self.command} {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n{headers}\r\n'.encode('latin1'))
            # Byte relay also supports WebSocket upgrades. Every new CONNECT is
            # revalidated, redirects require a new validated proxy request.
            while True:
                ready, _, _ = select.select([self.connection, upstream], [], [], 60)
                if not ready:
                    return
                for src in ready:
                    data = src.recv(65536)
                    if not data:
                        return
                    dst = upstream if src is self.connection else self.connection
                    dst.sendall(data)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    request_queue_size = 64

    def get_request(self):
        sock, addr = super().get_request()
        sock.settimeout(30)
        return sock, addr


if __name__ == '__main__':
    Server(('0.0.0.0', 3128), Handler).serve_forever()
