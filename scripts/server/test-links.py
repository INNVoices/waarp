#!/usr/bin/env python3
"""Checks share links end to end through a local sing-box engine (the Waarp desktop engine works).

    python scripts/server/test-links.py --engine engine/sing-box.exe LINKS_FILE
    ssh root@SERVER 'cat /opt/waarp-proxy/clients/*.txt' | python scripts/server/test-links.py --engine engine/sing-box.exe -

For each vless/hysteria2/tuic/trojan/ss link: builds a client config with a SOCKS inbound
(the same fields the Android importer produces), starts the engine and fetches
https://www.gstatic.com/generate_204 and the exit IP through it. Prints one line per link,
without credentials. Links stay in memory and in a temporary directory that is removed.
"""
import argparse, base64, json, os, subprocess, sys, tempfile, time, urllib.parse as up

def outbound(link):
    scheme = link.split("://", 1)[0].lower()
    u = up.urlsplit(link)
    q = dict(up.parse_qsl(u.query))
    uq = lambda s: up.unquote(s or "")

    def tls(reality=False):
        t = {"enabled": True, "server_name": q.get("sni") or u.hostname}
        if q.get("fp"):
            t["utls"] = {"enabled": True, "fingerprint": q["fp"]}
        if q.get("alpn"):
            t["alpn"] = q["alpn"].split(",")
        if reality:
            t["reality"] = {"enabled": True, "public_key": q["pbk"], "short_id": q.get("sid", "")}
        return t

    if scheme == "vless":
        o = {"type": "vless", "server": u.hostname, "server_port": u.port, "uuid": uq(u.username)}
        if q.get("flow"):
            o["flow"] = q["flow"]
        if q.get("security") in ("tls", "reality"):
            o["tls"] = tls(reality=q.get("security") == "reality")
        tp = q.get("type", "tcp")
        if tp == "grpc":
            o["transport"] = {"type": "grpc", "service_name": q.get("serviceName", "")}
        elif tp == "xhttp":
            o["transport"] = {"type": "xhttp", "path": q.get("path", "/"), "mode": q.get("mode", "auto")}
    elif scheme in ("hysteria2", "hy2"):
        o = {"type": "hysteria2", "server": u.hostname, "server_port": u.port, "password": uq(u.username), "tls": tls()}
        if q.get("obfs"):
            o["obfs"] = {"type": q["obfs"], "password": q["obfs-password"]}
    elif scheme == "tuic":
        o = {"type": "tuic", "server": u.hostname, "server_port": u.port, "uuid": uq(u.username),
             "password": uq(u.password), "congestion_control": q.get("congestion_control", "bbr"), "tls": tls()}
    elif scheme == "trojan":
        o = {"type": "trojan", "server": u.hostname, "server_port": u.port, "password": uq(u.username), "tls": tls()}
    elif scheme == "ss":
        cred = u.username
        method, password = base64.urlsafe_b64decode(cred + "=" * (-len(cred) % 4)).decode().split(":", 1)
        o = {"type": "shadowsocks", "server": u.hostname, "server_port": u.port, "method": method, "password": password}
    else:
        raise ValueError("unsupported scheme " + scheme)
    o["tag"] = "proxy"
    return o, uq(u.fragment) or scheme

def fetch(url, port, timeout=10):
    # curl understands socks5h; it ships with Windows 10+ and every Linux.
    r = subprocess.run(["curl", "-s", "-m", str(timeout), "--socks5-hostname", f"127.0.0.1:{port}",
                        "-o", "-", "-w", "\n%{http_code}", url], capture_output=True, text=True)
    body, _, code = r.stdout.rpartition("\n")
    return code, body.strip()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--port", type=int, default=10808)
    ap.add_argument("links")
    a = ap.parse_args()
    a.engine = os.path.abspath(a.engine)
    text =sys.stdin.read() if a.links == "-" else open(a.links, encoding="utf-8").read()
    links = [l.strip() for l in text.splitlines() if "://" in l]
    with tempfile.TemporaryDirectory() as tmp:
        cfg_path = os.path.join(tmp, "client.json")
        for link in links:
            try:
                o, name = outbound(link)
            except Exception as e:
                print(f"{'?':24} config error: {e}")
                continue
            cfg = {"log": {"level": "error"}, "inbounds": [{"type": "socks", "listen": "127.0.0.1", "listen_port": a.port}],
                   "outbounds": [o]}
            json.dump(cfg, open(cfg_path, "w"))
            p = subprocess.Popen([a.engine, "run", "-c", cfg_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                time.sleep(2)
                t0 = time.time()
                code, _ = fetch("https://www.gstatic.com/generate_204", a.port)
                ms = int((time.time() - t0) * 1000)
                _, ip = fetch("https://api.ipify.org", a.port)
                print(f"{name:24} {o['type']:12} http={code or '---'} {ms}ms exit={ip or 'none'}")
            finally:
                p.terminate()
                p.wait()

if __name__ == "__main__":
    main()
