#!/usr/bin/env python3
"""Loopback-only HTTP target for Android emulator VPN integration tests."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import urllib.request


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    counts: dict[str, int] = {}
    method_counts: dict[str, dict[str, int]] = {"GET": {}, "HEAD": {}}
    count_lock = threading.Lock()

    def do_GET(self):
        self.respond(send_body=True)

    def do_HEAD(self):
        # The pinned native URL tester uses HEAD. It must reach the same endpoint
        # and counter path as the independent test application's GET request.
        self.respond(send_body=False)

    def respond(self, send_body):
        path = self.path.split("?", 1)[0]
        with self.count_lock:
            self.counts[path] = self.counts.get(path, 0) + 1
            methods = self.method_counts[self.command]
            methods[path] = methods.get(path, 0) + 1
        if path == "/generate_204":
            status, content_type, body = 204, "text/plain", b""
        elif path == "/health":
            status, content_type, body = 200, "text/plain", b"waarp-android-fixture\n"
        elif path == "/payload":
            status, content_type, body = 200, "application/octet-stream", bytes(range(256)) * 256
        elif path == "/stats":
            with self.count_lock:
                body = json.dumps({"requests": self.counts, "methods": self.method_counts}, sort_keys=True).encode()
            status, content_type = 200, "application/json"
        else:
            status, content_type, body = 404, "text/plain", b"not found\n"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if send_body and body:
            self.wfile.write(body)

    def log_message(self, format, *args):
        # No headers, credentials or arbitrary request text enter CI artifacts.
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18080)
    parser.add_argument("--stats-report", type=Path, help="Read only counters from an already-running local fixture and exit")
    options = parser.parse_args()
    if options.stats_report:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{options.port}/stats", timeout=5) as response:
            content = response.read(65_537)
        if len(content) > 65_536:
            raise ValueError("The fixture counter report exceeds its limit.")
        counters = json.loads(content)
        if not isinstance(counters, dict) or set(counters) != {"requests", "methods"} or \
                not isinstance(counters["methods"], dict) or set(counters["methods"]) != {"GET", "HEAD"}:
            raise ValueError("Unexpected fixture counter schema.")
        allowed = {"/health", "/generate_204", "/payload", "/stats"}

        def sanitized(counts):
            if not isinstance(counts, dict) or any(type(count) is not int or count < 0 for count in counts.values()):
                raise ValueError("Unexpected fixture counter value.")
            return {path: counts.get(path, 0) for path in sorted(allowed)}

        report = {"schemaVersion": 2, "requests": sanitized(counters["requests"]),
                  "methods": {method: sanitized(counters["methods"][method]) for method in ("GET", "HEAD")},
                  "unknownPathRequests": sum(count for path, count in counters["requests"].items() if path not in allowed)}
        options.stats_report.parent.mkdir(parents=True, exist_ok=True)
        options.stats_report.write_text(json.dumps(report, indent=2) + "\n")
        print("Saved local HTTP fixture request counters.")
        raise SystemExit(0)
    server = ThreadingHTTPServer(("127.0.0.1", options.port), FixtureHandler)
    server.daemon_threads = True
    print(f"Android test fixture listening on 127.0.0.1:{options.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
