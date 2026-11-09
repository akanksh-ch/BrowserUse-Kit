#!/bin/bash
set -e
PASSWORD="${PASSWORD:-agent}"
echo "agent:$PASSWORD" | chpasswd
# first run on empty volume: seed home from skel
if [ ! -f /home/agent/.bashrc ]; then
  cp -rT /etc/skel /home/agent
fi
mkdir -p /home/agent/.vnc /home/agent/.ssh /home/agent/.ssh-hostkeys
# persist ssh host keys so clients don't see changing fingerprints
ssh-keygen -A >/dev/null 2>&1 || true
for k in /home/agent/.ssh-hostkeys/ssh_host_*; do [ -e "$k" ] && cp "$k" /etc/ssh/; done
[ -e /home/agent/.ssh-hostkeys/ssh_host_ed25519_key ] || cp /etc/ssh/ssh_host_* /home/agent/.ssh-hostkeys/
chmod 600 /etc/ssh/ssh_host_*_key
printf '%s' "$PASSWORD" | vncpasswd -f > /home/agent/.vnc/passwd
chmod 600 /home/agent/.vnc/passwd
chown -R agent:agent /home/agent
# trust the local CA that Caddy generates for https://vault (needed by the Bitwarden extension)
for _ in $(seq 60); do [ -f /caddy/caddy/pki/authorities/local/root.crt ] && break; sleep 1; done
if [ -f /caddy/caddy/pki/authorities/local/root.crt ]; then
  install -m 644 /caddy/caddy/pki/authorities/local/root.crt /tmp/caddy-root.crt
  su agent -c 'mkdir -p ~/.pki/nssdb; [ -f ~/.pki/nssdb/cert9.db ] || certutil -d sql:$HOME/.pki/nssdb -N --empty-password
    certutil -d sql:$HOME/.pki/nssdb -D -n caddy-local 2>/dev/null
    certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n caddy-local -i /tmp/caddy-root.crt' || echo 'warning: could not trust Caddy CA'
fi
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
