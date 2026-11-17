#!/usr/bin/env python3
"""Deploys the Waarp multi-protocol server set into /opt/waarp-proxy (run on the server as root).

    proxy-deploy.py --host SERVER_IP --domain DOMAIN [--client NAME]
                    [--sing-box IMAGE] [--xray IMAGE] [--dir /opt/waarp-proxy]

DOMAIN must resolve to SERVER_IP and have a Let's Encrypt certificate in
/etc/letsencrypt/live/DOMAIN/ (Hysteria2, TUIC and Trojan need a real certificate:
the Android importer refuses `insecure` and certificate pins). TCP 443 is not used,
so an existing web server on 443 keeps working. See docs/SERVER.md.

Two host-network containers:
  sing-box  VLESS+REALITY+Vision TCP 2083 / 2087 / 2096 (three SNI covers),
            Hysteria2 UDP 443 (salamander), TUIC v5 UDP 8443, Trojan TLS TCP 2053,
            Shadowsocks-2022 TCP+UDP 8388
  Xray      VLESS+XHTTP+REALITY TCP 2443, VLESS+gRPC+REALITY TCP 2098

Secrets are generated once and kept in DIR/secrets.json (mode 600); re-running keeps them,
so already imported client links stay valid. One share link per protocol is written to
DIR/clients/<inbound>.txt. Nothing secret is printed.
"""
import argparse, base64, json, os, secrets, shutil, subprocess, sys, time, urllib.parse, uuid

ap = argparse.ArgumentParser()
ap.add_argument("--host", required=True)
ap.add_argument("--domain", required=True)
ap.add_argument("--client", default="client")
ap.add_argument("--sing-box", dest="sb", default="ghcr.io/sagernet/sing-box:v1.14.4")
ap.add_argument("--xray", default="ghcr.io/xtls/xray-core@sha256:9812e382e229e9ed63fd179bf1a4e3fe244c12ff3ae4fd8128745d79c87575ab")
ap.add_argument("--dir", default="/opt/waarp-proxy")
ap.add_argument("--reality-cover", default="www.microsoft.com", help="foreign SNI for the 2083 inbound")
ap.add_argument("--reality-local-cover", default="vk.com", help="Russian SNI for the 2096 inbound")
a = ap.parse_args()

DIR, HOST, DOMAIN = a.dir, a.host, a.domain
CERT = f"/etc/letsencrypt/live/{DOMAIN}/fullchain.pem"
KEY = f"/etc/letsencrypt/live/{DOMAIN}/privkey.pem"
if not os.path.exists(CERT):
    sys.exit(f"no certificate for {DOMAIN} in /etc/letsencrypt/live")
os.umask(0o077)
os.makedirs(f"{DIR}/clients", exist_ok=True)
os.chmod(DIR, 0o700)

stamp = time.strftime("%Y%m%d-%H%M%S")
for f in ("config.json", "xray.json", "docker-compose.yml"):
    p = f"{DIR}/{f}"
    if os.path.exists(p):
        shutil.copy2(p, f"{p}.bak-{stamp}")

def run(*cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout

sp = f"{DIR}/secrets.json"
S = json.load(open(sp)) if os.path.exists(sp) else {}
if "reality_private" not in S:
    kp = run("docker", "run", "--rm", a.sb, "generate", "reality-keypair")
    kv = dict(line.split(": ", 1) for line in kp.strip().splitlines())
    S.update(reality_private=kv["PrivateKey"], reality_public=kv["PublicKey"],
             reality_short_id=secrets.token_hex(8), vless_uuid=str(uuid.uuid4()))
S.setdefault("hy2_password", secrets.token_urlsafe(24))
S.setdefault("hy2_obfs", secrets.token_urlsafe(24))
S.setdefault("tuic_uuid", str(uuid.uuid4()))
S.setdefault("tuic_password", secrets.token_urlsafe(24))
S.setdefault("trojan_password", secrets.token_urlsafe(24))
S.setdefault("ss_password", base64.b64encode(secrets.token_bytes(16)).decode())
S.setdefault("xhttp_path", "/" + secrets.token_hex(6))
S.setdefault("grpc_service", "svc" + secrets.token_hex(4))
json.dump(S, open(sp, "w"), indent=2)

def reality_in(tag, port, sni):
    return {"type": "vless", "tag": tag, "listen": "::", "listen_port": port,
            "users": [{"name": a.client, "uuid": S["vless_uuid"], "flow": "xtls-rprx-vision"}],
            "tls": {"enabled": True, "server_name": sni,
                    "reality": {"enabled": True, "handshake": {"server": sni, "server_port": 443},
                                "private_key": S["reality_private"], "short_id": [S["reality_short_id"]]}}}

cert_tls = {"enabled": True, "server_name": DOMAIN, "certificate_path": CERT, "key_path": KEY}
sb = {
    "log": {"level": "warn", "timestamp": True},
    "inbounds": [
        reality_in("reality-ms-2083", 2083, a.reality_cover),
        reality_in("reality-self-2087", 2087, DOMAIN),
        reality_in("reality-vk-2096", 2096, a.reality_local_cover),
        {"type": "hysteria2", "tag": "hy2-443", "listen": "::", "listen_port": 443,
         "users": [{"name": a.client, "password": S["hy2_password"]}],
         "obfs": {"type": "salamander", "password": S["hy2_obfs"]},
         "tls": dict(cert_tls, alpn=["h3"])},
        {"type": "tuic", "tag": "tuic-8443", "listen": "::", "listen_port": 8443,
         "users": [{"name": a.client, "uuid": S["tuic_uuid"], "password": S["tuic_password"]}],
         "congestion_control": "bbr", "tls": dict(cert_tls, alpn=["h3"])},
        {"type": "trojan", "tag": "trojan-2053", "listen": "::", "listen_port": 2053,
         "users": [{"name": a.client, "password": S["trojan_password"]}],
         "tls": dict(cert_tls, alpn=["h2", "http/1.1"])},
        {"type": "shadowsocks", "tag": "ss-8388", "listen": "::", "listen_port": 8388,
         "method": "2022-blake3-aes-128-gcm", "password": S["ss_password"]},
    ],
    "outbounds": [{"type": "direct", "tag": "direct"}],
}
json.dump(sb, open(f"{DIR}/config.json", "w"), indent=2)

def xr_reality():
    return {"show": False, "target": f"{DOMAIN}:443", "serverNames": [DOMAIN],
            "privateKey": S["reality_private"], "shortIds": [S["reality_short_id"]]}
vless_clients = {"clients": [{"id": S["vless_uuid"], "email": a.client}], "decryption": "none"}
xr = {
    "log": {"loglevel": "warning"},
    "inbounds": [
        {"tag": "xhttp-reality-2443", "listen": "0.0.0.0", "port": 2443, "protocol": "vless", "settings": vless_clients,
         "streamSettings": {"network": "xhttp", "xhttpSettings": {"path": S["xhttp_path"], "mode": "auto"},
                            "security": "reality", "realitySettings": xr_reality()}},
        {"tag": "grpc-reality-2098", "listen": "0.0.0.0", "port": 2098, "protocol": "vless", "settings": vless_clients,
         "streamSettings": {"network": "grpc", "grpcSettings": {"serviceName": S["grpc_service"]},
                            "security": "reality", "realitySettings": xr_reality()}},
    ],
    "outbounds": [{"protocol": "freedom", "tag": "direct"}],
}
json.dump(xr, open(f"{DIR}/xray.json", "w"), indent=2)
os.chmod(f"{DIR}/xray.json", 0o644)  # the Xray image runs as a non-root user; DIR itself stays 700

open(f"{DIR}/docker-compose.yml", "w").write(f"""services:
  waarp-proxy:
    image: {a.sb}
    container_name: waarp-proxy
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./config.json:/etc/sing-box/config.json:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
    command: ["run", "-c", "/etc/sing-box/config.json"]
  waarp-xray:
    image: {a.xray}
    container_name: waarp-xray
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./xray.json:/etc/xray/config.json:ro
    command: ["run", "-c", "/etc/xray/config.json"]
""")

enc = lambda s: urllib.parse.quote(s, safe="")
def vless(port, sni, name, **extra):
    q = {"security": "reality", "sni": sni, "fp": "ios", "pbk": S["reality_public"], "sid": S["reality_short_id"]}
    q.update(extra)
    return f"vless://{S['vless_uuid']}@{HOST}:{port}?{urllib.parse.urlencode(q)}#{name}"
ss_user = base64.urlsafe_b64encode(f"2022-blake3-aes-128-gcm:{S['ss_password']}".encode()).decode().rstrip("=")
links = {
    "reality-ms-2083": vless(2083, a.reality_cover, "Reality-Foreign", type="tcp", flow="xtls-rprx-vision"),
    "reality-self-2087": vless(2087, DOMAIN, "Reality-Self", type="tcp", flow="xtls-rprx-vision"),
    "reality-vk-2096": vless(2096, a.reality_local_cover, "Reality-RU-SNI", type="tcp", flow="xtls-rprx-vision"),
    "xhttp-reality-2443": vless(2443, DOMAIN, "XHTTP-Reality", type="xhttp", path=S["xhttp_path"], mode="auto"),
    "grpc-reality-2098": vless(2098, DOMAIN, "gRPC-Reality", type="grpc", serviceName=S["grpc_service"]),
    "hy2-443": f"hysteria2://{enc(S['hy2_password'])}@{HOST}:443?sni={DOMAIN}&obfs=salamander&obfs-password={enc(S['hy2_obfs'])}#Hysteria2",
    "tuic-8443": f"tuic://{S['tuic_uuid']}:{enc(S['tuic_password'])}@{HOST}:8443?sni={DOMAIN}&alpn=h3&congestion_control=bbr#TUIC",
    "trojan-2053": f"trojan://{enc(S['trojan_password'])}@{HOST}:2053?security=tls&sni={DOMAIN}&fp=firefox&type=tcp#Trojan",
    "ss-8388": f"ss://{ss_user}@{HOST}:8388#SS2022",
}
for k, v in links.items():
    open(f"{DIR}/clients/{k}.txt", "w").write(v + "\n")

run("docker", "run", "--rm", "-v", f"{DIR}/config.json:/c.json:ro", "-v", "/etc/letsencrypt:/etc/letsencrypt:ro",
    a.sb, "check", "-c", "/c.json")
run("docker", "run", "--rm", "-v", f"{DIR}/xray.json:/c.json:ro", a.xray, "run", "-test", "-c", "/c.json")
subprocess.run(["docker", "compose", "up", "-d"], cwd=DIR, check=True, capture_output=True)
print("deployed; links in", f"{DIR}/clients:", ", ".join(links))
