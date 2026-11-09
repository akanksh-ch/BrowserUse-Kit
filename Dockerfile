FROM debian:stable-slim
ENV RESOLUTION=1440x900 DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      xfce4 xfce4-terminal dbus-x11 tigervnc-standalone-server tigervnc-tools novnc websockify \
      openssh-server tmux supervisor sudo curl ca-certificates git nano procps \
      chromium nodejs npm xdotool wmctrl scrot xauth x11-apps python3-venv python3-pyatspi at-spi2-core libnss3-tools fonts-noto-color-emoji fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash -G sudo agent \
    && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent \
    && mkdir -p /run/sshd \
    && ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html \
    && echo 'CHROMIUM_FLAGS="--no-sandbox --disable-dev-shm-usage --no-first-run --user-data-dir=/home/agent/.chromium-profile --remote-debugging-port=9222"' > /etc/chromium.d/container \
    && echo "export DISPLAY=\"\${DISPLAY:-:1}\" DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-session" > /etc/profile.d/display.sh \
    && echo ": \"\${DISPLAY:=:1}\"; export DISPLAY" >> /etc/bash.bashrc
ENV DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-session QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 GTK_A11Y=atspi
RUN python3 -m venv --system-site-packages /opt/venv && /opt/venv/bin/pip install --no-cache-dir "mcp<2"
RUN npm install -g chrome-devtools-mcp@latest @anthropic-ai/claude-code
COPY rootfs/ /
RUN chmod +x /entrypoint.sh
VOLUME /home/agent
EXPOSE 6080 22
ENTRYPOINT ["/entrypoint.sh"]
