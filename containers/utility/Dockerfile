FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 tini && \
    mkdir -p /opt/browseruse && dpkg-query -W > /opt/browseruse/packages.lock && rm -rf /var/lib/apt/lists/* && \
    useradd --uid 1000 --create-home worker && mkdir /workspace && chown 1000:1000 /workspace
USER 1000:1000
WORKDIR /workspace
ENV HOME=/home/worker HTTP_PROXY=http://egress:3128 HTTPS_PROXY=http://egress:3128 http_proxy=http://egress:3128 https_proxy=http://egress:3128
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
