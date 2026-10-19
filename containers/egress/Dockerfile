FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && mkdir -p /opt/browseruse && dpkg-query -W > /opt/browseruse/packages.lock && rm -rf /var/lib/apt/lists/* && useradd --uid 1000 egress
COPY proxy.py /opt/browseruse/proxy.py
USER 1000:1000
ENTRYPOINT ["python3", "-u", "/opt/browseruse/proxy.py"]
