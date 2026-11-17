#!/bin/bash
# Adds one AmneziaWG client to a running awg-quick interface without restarting it,
# so existing clients stay connected. Run on the server as root.
#
#   awg-add-client.sh NAME ADDRESS ENDPOINT_HOST [INTERFACE]
#   awg-add-client.sh phone 10.9.9.8 vpn.example.org
#
# - Backs up /etc/amnezia/amneziawg/<iface>.conf before changing it.
# - Appends the [Peer] block (persistent) and applies it live with `awg set`.
# - Copies the interface obfuscation parameters (Jc, Jmin, Jmax, S1-S4, H1-H4, I1-I5)
#   into the client config, so the client matches the server exactly.
# - Writes the client config to /root/awg/client-NAME.conf (mode 600). Prints no keys.
set -euo pipefail
NAME="$1"; ADDR="$2"; ENDPOINT_HOST="$3"; IFACE="${4:-awg0}"
CONF="/etc/amnezia/amneziawg/$IFACE.conf"
OUT="/root/awg/client-$NAME.conf"
[ -e "$OUT" ] && { echo "client $NAME already exists"; exit 1; }
grep -q "AllowedIPs = $ADDR/32" "$CONF" && { echo "address $ADDR already used"; exit 1; }
PORT=$(awg show "$IFACE" listen-port)
cp -p "$CONF" "$CONF.bak-$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir -p /root/awg
PRIV=$(awg genkey); PUB=$(printf '%s' "$PRIV" | awg pubkey)
SPUB=$(awg show "$IFACE" public-key)
printf '\n[Peer]\n# %s %s\nPublicKey = %s\nAllowedIPs = %s/32\n' "$NAME" "$(date +%F)" "$PUB" "$ADDR" >> "$CONF"
awg set "$IFACE" peer "$PUB" allowed-ips "$ADDR/32"
ip route replace "$ADDR/32" dev "$IFACE" 2>/dev/null || true
PARAMS=$(sed -n '/^\[Interface\]/,/^\[Peer\]/p' "$CONF" | grep -E '^(Jc|Jmin|Jmax|S[1-4]|H[1-4]|I[1-5]) *=')
{
  printf '[Interface]\nPrivateKey = %s\nAddress = %s/32\nDNS = 8.8.8.8, 1.1.1.1\n\n%s\n\n' "$PRIV" "$ADDR" "$PARAMS"
  printf '[Peer]\nPublicKey = %s\nAllowedIPs = 0.0.0.0/0\nEndpoint = %s:%s\nPersistentKeepalive = 25\n' "$SPUB" "$ENDPOINT_HOST" "$PORT"
} > "$OUT"
chmod 600 "$OUT"
echo "added $NAME $ADDR on $IFACE, peers now: $(awg show "$IFACE" peers | wc -l), config: $OUT"
