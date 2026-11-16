#!/usr/bin/env python3
"""Own a disposable, loopback-only AWG2 peer for Android emulator acceptance.

The peer exchanges public keys with the emulator and keeps both private keys in
the process that generated them. Only an allowlisted counter report is copied
into the CI artifacts. This helper is for Linux test runners, not production.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request


BOOL_FIELDS = {
    "client_registered", "authenticated_handshake", "awg_handshake_header_padding_observed",
    "awg_transport_header_padding_observed", "plaintext_dns_absent_from_outer_udp", "stopped", "passed", "http_server_started",
}
COUNT_FIELDS = {"encrypted_dns_replies", "outer_datagrams_sent", "outer_datagrams_received", "device_error_events",
                "encrypted_dns_unique_queries", "encrypted_http_requests", "encrypted_http_unique_requests", "encrypted_http_bytes",
                "first_encrypted_request_unix_ms", "last_encrypted_request_unix_ms"}


def process_identity(pid):
    try:
        fields = (Path("/proc") / str(pid) / "stat").read_text().rsplit(") ", 1)[1].split()
        if fields[0] == "Z":
            return None
        return {"startTime": fields[19], "binary": str((Path("/proc") / str(pid) / "exe").resolve(strict=True))}
    except (OSError, IndexError):
        return None


def owned_process(state):
    identity = process_identity(state["pid"])
    return identity is not None and identity == {"startTime": state["startTime"], "binary": state["binary"]}


def stop_process(state):
    if not owned_process(state):
        return
    os.kill(state["pid"], signal.SIGTERM)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if not owned_process(state):
            return
        time.sleep(0.1)
    # Revalidate the executable and Linux start time before signalling a PID.
    if owned_process(state):
        os.kill(state["pid"], signal.SIGKILL)
        raise ValueError("The owned AWG fixture did not stop within 15 seconds.")


def read_proof(path):
    if path.stat().st_size > 8192:
        raise ValueError("AWG proof exceeds the fixed counter report size.")
    proof = json.loads(path.read_text())
    expected = BOOL_FIELDS | COUNT_FIELDS | {"mode", "wireguard_revision"}
    if not isinstance(proof, dict) or set(proof) != expected:
        raise ValueError("AWG proof does not match the public counter schema.")
    if proof["mode"] != "android_awg2_peer" or not re.fullmatch(r"[0-9a-f]{40}", str(proof["wireguard_revision"])):
        raise ValueError("AWG proof has unexpected fixture provenance.")
    if any(type(proof[key]) is not bool for key in BOOL_FIELDS):
        raise ValueError("AWG proof has a non-boolean status.")
    if any(type(proof[key]) is not int or proof[key] < 0 for key in COUNT_FIELDS):
        raise ValueError("AWG proof has a non-counter value.")
    passed = all(proof[key] for key in BOOL_FIELDS - {"passed", "http_server_started"}) and proof["encrypted_dns_replies"] >= 2 and \
        proof["outer_datagrams_sent"] > 0 and proof["outer_datagrams_received"] > 0 and proof["device_error_events"] == 0
    if proof["passed"] != passed:
        raise ValueError("AWG proof verdict disagrees with its recorded counters.")
    return proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "stop"))
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--report", type=Path, default=Path("out/android/device-tests/awg-proof.json"))
    parser.add_argument("--port", type=int, default=18081)
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--require-passed", action="store_true")
    parser.add_argument("--duration", default="30m", help="Owned peer lifetime: Go duration from 1m to 4h")
    options = parser.parse_args()
    state_dir = options.state_dir
    if state_dir is None:
        runner_temp = os.environ.get("RUNNER_TEMP")
        if not runner_temp:
            raise ValueError("Set RUNNER_TEMP or provide an owned --state-dir.")
        state_dir = Path(runner_temp) / "waarp-android-awg"
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state_dir.is_symlink() or state_dir.stat().st_uid != os.getuid():
        raise ValueError("The AWG state directory must belong to this runner.")
    state_file = state_dir / "process.json"
    if options.action == "start":
        if not options.binary or not 1024 <= options.port <= 65535:
            raise ValueError("Provide the built --binary and an unprivileged loopback port.")
        if state_file.exists():
            previous = json.loads(state_file.read_text())
            if owned_process(previous):
                raise ValueError("An owned AWG fixture is already running.")
            raise ValueError("A previous fixture needs its stop/report step before starting again.")
        binary = options.binary.resolve(strict=True)
        report = options.report.resolve()
        report.parent.mkdir(parents=True, exist_ok=True)
        raw_report = (state_dir / "raw-proof.json").resolve()
        raw_report.unlink(missing_ok=True)
        child = subprocess.Popen([str(binary), "--android-server", "--android-port", str(options.port),
                                  "--android-report", str(raw_report), "--android-duration", options.duration], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        identity = process_identity(child.pid)
        if identity is None or identity["binary"] != str(binary):
            child.terminate()
            child.wait(timeout=10)
            raise ValueError("The AWG fixture exited before recording its owned process.")
        state = {"pid": child.pid, **identity, "rawReport": str(raw_report), "report": str(report)}
        with state_file.open("x") as output:
            os.chmod(state_file, 0o600)
            json.dump(state, output)
        # Ignore HTTP proxy environment variables for this explicit loopback API.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise ValueError("The AWG fixture exited before its health check.")
            try:
                with opener.open(f"http://127.0.0.1:{options.port}/health", timeout=1) as response:
                    if response.status == 200:
                        print("Disposable AWG2 peer ready; private keys remain in memory.")
                        return 0
            except (OSError, urllib.error.URLError):
                time.sleep(0.1)
        stop_process(state)
        raise ValueError("The AWG fixture did not become ready within 15 seconds.")
    if not state_file.exists():
        print("No owned AWG fixture was started; nothing to stop.")
        return 0
    state = json.loads(state_file.read_text())
    stop_process(state)
    proof = read_proof(Path(state["rawReport"]))
    Path(state["report"]).write_text(json.dumps(proof, indent=2) + "\n")
    state_file.unlink()
    Path(state["rawReport"]).unlink(missing_ok=True)
    print(f"AWG peer stopped: {proof['encrypted_dns_replies']} encrypted DNS replies; proof {'PASS' if proof['passed'] else 'FAIL'}.")
    return 0 if proof["passed"] or not options.require_passed else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print(f"Android AWG fixture failed: {error}", file=sys.stderr)
        raise SystemExit(1)
