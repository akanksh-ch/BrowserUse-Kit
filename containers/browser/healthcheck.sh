#!/bin/sh
set -eu
xdpyinfo >/dev/null 2>&1
curl -fsS --max-time 2 http://127.0.0.1:9222/json/version >/dev/null
python3 -c 'import socket; s=socket.create_connection(("127.0.0.1",5900),2); assert s.recv(12).startswith(b"RFB "); s.close()'
