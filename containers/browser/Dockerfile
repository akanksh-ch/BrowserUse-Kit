FROM debian:bookworm-slim
ARG CHROME_VERSION
RUN test -n "$CHROME_VERSION" || (echo 'CHROME_VERSION must be an exact available Google Chrome version' >&2; exit 1)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 xvfb fluxbox x11vnc novnc websockify socat util-linux x11-utils && \
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg && \
    echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' > /etc/apt/sources.list.d/google-chrome.list && \
    apt-get update && apt-get install -y --no-install-recommends google-chrome-stable="$CHROME_VERSION" && \
    mkdir -p /opt/browseruse && dpkg-query -W > /opt/browseruse/packages.lock && rm -rf /var/lib/apt/lists/* && \
    useradd --uid 1000 --create-home browser && mkdir -p /profile /workspace/downloads /etc/opt/chrome/policies/managed && chown -R 1000:1000 /profile /workspace
COPY policy.json /etc/opt/chrome/policies/managed/browseruse.json
COPY entrypoint.sh healthcheck.sh /usr/local/bin/
RUN chmod 755 /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh
USER 1000:1000
ENV DISPLAY=:99 HOME=/home/browser
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s CMD ["/usr/local/bin/healthcheck.sh"]
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
