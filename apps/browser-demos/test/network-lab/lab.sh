#!/bin/bash
# Build the lab topology, then serve one Playwright browser per home.
#
#   "internet" (this container's namespace)   203.0.113.1/24 on bridge wan0
#     STUN server         203.0.113.1:3478
#     web forwarder       203.0.113.1:$DEV_PORT -> dev server on the test host
#   router-a  wan 203.0.113.10  --NAT--  lan 192.168.1.1  --  home-a 192.168.1.2
#   router-b  wan 203.0.113.20  --NAT--  lan 192.168.2.1  --  home-b 192.168.2.2
#
# Each router masquerades its home behind its single public address and
# drops unsolicited inbound traffic, as a household router does. The internet has no route to either home and does
# not forward, so home-a reaches home-b only through both NATs.
set -euo pipefail
DEV_PORT="${1:?usage: lab.sh <dev-server-port>}"
INTERNET=203.0.113.1

sysctl -qw net.ipv4.ip_forward=0
# The lab is IPv4-only, as session networks are. An interface that comes up
# with IPv6 gains a link-local address a moment later, and Chromium treats
# that as a network change and aborts the page's in-flight requests, so a
# test starting right after the lab does would see a broken page load.
sysctl -qw net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1
ip link add wan0 type bridge
ip addr add "$INTERNET/24" dev wan0
ip link set wan0 up
# Only the homes' own subnets: Docker Desktop's gateway and DNS live
# elsewhere in 192.168.0.0/16.
ip route add unreachable 192.168.1.0/24
ip route add unreachable 192.168.2.0/24

home() {
  local name=$1 wan=$2 lan=$3
  ip netns add "router-$name"
  ip netns add "home-$name"
  for ns in "router-$name" "home-$name"; do
    ip netns exec "$ns" sysctl -qw net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1
  done
  ip link add "wan-$name" type veth peer name wan netns "router-$name"
  ip link set "wan-$name" master wan0 up
  ip link add "lan-$name" type veth peer name eth0 netns "home-$name"
  ip link set "lan-$name" netns "router-$name"
  ip -n "router-$name" link set lo up
  ip -n "router-$name" addr add "$wan/24" dev wan
  ip -n "router-$name" link set wan up
  ip -n "router-$name" link set "lan-$name" name lan
  ip -n "router-$name" addr add "$lan.1/24" dev lan
  ip -n "router-$name" link set lan up
  ip -n "router-$name" route add default via "$INTERNET"
  ip netns exec "router-$name" sysctl -qw net.ipv4.ip_forward=1
  ip netns exec "router-$name" iptables -t nat -A POSTROUTING -o wan -j MASQUERADE
  # A household router's firewall: nothing unsolicited from the internet
  # reaches the router or the home. Dropping it before conntrack confirms
  # the flow also matters for the NAT's mapping. Without the firewall, a
  # peer's early connectivity check would be recorded as an inbound flow on
  # the public port, and the home's own reply would then be mapped to a
  # different port, so the address STUN reported would stop working (a
  # symmetric NAT). With it, the router keeps one public port per home
  # socket and admits only replies, as STUN-only traversal expects.
  ip netns exec "router-$name" iptables -A INPUT -i wan -m conntrack --ctstate NEW,INVALID -j DROP
  ip netns exec "router-$name" iptables -A FORWARD -i wan -m conntrack --ctstate NEW,INVALID -j DROP
  ip -n "home-$name" link set lo up
  ip -n "home-$name" addr add "$lan.2/24" dev eth0
  ip -n "home-$name" link set eth0 up
  ip -n "home-$name" route add default via "$lan.1"
}
home a 203.0.113.10 192.168.1
home b 203.0.113.20 192.168.2

# Interface, address and route changes in every namespace, timestamped, so a
# failing run can show whether the network moved under a browser.
for ns in router-a home-a router-b home-b; do
  ip -n "$ns" -ts monitor all > "/lab/netlink-$ns.log" 2>&1 &
done

turnserver -n --stun-only --no-cli --simple-log --log-file=stdout \
  --listening-ip="$INTERNET" --listening-port=3478 >/tmp/stun.log 2>&1 &
socat "TCP-LISTEN:$DEV_PORT,bind=$INTERNET,fork,reuseaddr" \
  "TCP:host.docker.internal:$DEV_PORT" &

CHROME="$(node -e "console.log(require('/usr/lib/node_modules/playwright').chromium.executablePath())")"
for name in a b; do
  printf '#!/bin/sh\nexec ip netns exec home-%s %s "$@"\n' "$name" "$CHROME" > "/lab/chrome-home-$name"
  chmod +x "/lab/chrome-home-$name"
done

exec node - "$DEV_PORT" <<'NODE'
const { chromium } = require("/usr/lib/node_modules/playwright");
const port = process.argv[2];
(async () => {
  for (const [name, wsPort] of [["a", 9101], ["b", 9102]]) {
    const server = await chromium.launchServer({
      executablePath: `/lab/chrome-home-${name}`,
      host: "0.0.0.0",
      port: wsPort,
      wsPath: `/home-${name}`,
      // The page is served over plain HTTP from the lab's internet address;
      // treat that one origin as secure so service workers and cross-origin
      // isolation behave as on an https deployment.
      args: [`--unsafely-treat-insecure-origin-as-secure=http://203.0.113.1:${port}`],
    });
    console.log(`LAB home-${name} ${server.wsEndpoint()}`);
  }
  console.log("LAB ready");
})().catch((error) => { console.error(error); process.exit(1); });
NODE
