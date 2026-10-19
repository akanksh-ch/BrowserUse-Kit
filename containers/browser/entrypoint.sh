#!/bin/sh
set -eu
[ "$(id -u)" != 0 ] || { echo 'Chrome must not run as root' >&2; exit 1; }
umask 077
# Host supervisor installs namespace egress rules before allowing Chrome startup.
i=0
until [ -f /tmp/network-ready ]; do i=$((i+1)); [ "$i" -lt 300 ] || exit 1; sleep .1; done
mkdir -p /profile/chrome /workspace/downloads
exec 9>/profile/runtime.lock
flock -n 9 || { echo 'Profile already locked' >&2; exit 1; }
# Require user namespaces; never fall back to disabling the sandbox.
unshare -Ur true || { echo 'User namespace sandbox unavailable: check kernel/seccomp configuration' >&2; exit 1; }
pids=''
cleanup() {
  trap - EXIT TERM INT
  [ -z "${chrome:-}" ] || kill -TERM "$chrome" 2>/dev/null || true
  [ -z "${chrome:-}" ] || wait "$chrome" 2>/dev/null || true
  for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
  wait || true
}
trap cleanup EXIT TERM INT
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -ac & pids="$pids $!"
i=0
until xdpyinfo >/dev/null 2>&1; do i=$((i+1)); [ "$i" -lt 50 ] || exit 1; sleep .1; done
fluxbox & pids="$pids $!"
# Raw VNC is private. No websockify listener: the trusted control gate owns it.
x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -noxdamage -noclipboard & pids="$pids $!"
google-chrome-stable --user-data-dir=/profile/chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --disable-dev-shm-usage --no-first-run --disable-sync --password-store=basic --proxy-server=http://egress:3128 '--proxy-bypass-list=<-loopback>' about:blank & chrome=$!
# Chrome binds loopback; relay only on the workspace-private network.
socat TCP-LISTEN:9223,reuseaddr,fork TCP:127.0.0.1:9222 & pids="$pids $!"
while kill -0 "$chrome" 2>/dev/null; do
  for pid in $pids; do kill -0 "$pid" 2>/dev/null || exit 1; done
  sleep 1
done
exit 1
