# A Linux lab for network sessions across separate networks. Two "homes",
# each a network namespace behind its own NAT router namespace, reach an
# "internet" (the container's own namespace) that runs a STUN server and
# forwards web traffic to the Kandelo dev server on the machine running the
# tests. A Chromium runs inside each home; Playwright drives it over a pipe,
# so the only network path between the homes is through both NATs.
# The Playwright version must match apps/browser-demos/package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      iproute2 iptables coturn socat \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g playwright@1.63.0
COPY lab.sh /lab/lab.sh
ENTRYPOINT ["/lab/lab.sh"]
