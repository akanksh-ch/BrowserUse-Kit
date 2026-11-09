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
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
