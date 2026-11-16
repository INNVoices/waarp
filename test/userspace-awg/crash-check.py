#!/usr/bin/env python3
"""Bounded SIGKILL/restart check for this harness; only owned children and loopback UDP."""
# SPDX-License-Identifier: Apache-2.0

import argparse
from contextlib import ExitStack
import errno
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import time


class CheckFailed(Exception):
    def __init__(self, stage, code):
        self.stage, self.code = stage, code


def wait_for_hold(child):
    deadline = time.monotonic() + 45
    pending = b""
    output_bytes = 0
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ, "stdout")
        selector.register(child.stderr, selectors.EVENT_READ, "stderr")
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            for key, _ in selector.select(max(0, min(0.5, remaining))):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                output_bytes += len(chunk)
                if output_bytes > 65536:
                    raise CheckFailed("holding_marker", "output_limit")
                if key.data != "stdout":
                    continue  # Never forward child logs or exception text.
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    try:
                        value = json.loads(line)
                    except (ValueError, UnicodeError):
                        raise CheckFailed("holding_marker", "invalid_json") from None
                    if not isinstance(value, dict):
                        raise CheckFailed("holding_marker", "invalid_json_shape")
                    if value.get("mode") != "local_awg_self_test" or value.get("stage") != "holding_after_success":
                        continue
                    ports = (value.get("client_loopback_port"), value.get("server_loopback_port"))
                    if any(type(port) is not int or not 1 <= port <= 65535 for port in ports) or ports[0] == ports[1]:
                        raise CheckFailed("holding_marker", "invalid_ports")
                    if child.poll() is not None:
                        raise CheckFailed("holding_marker", "child_exited")
                    return ports
            if child.poll() is not None:
                raise CheckFailed("holding_marker", "child_exited")
    raise CheckFailed("holding_marker", "timeout")


def require_ports_busy(child, ports):
    for port in ports:
        if child.poll() is not None:
            raise CheckFailed("ports_while_alive", "child_exited")
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError as error:
                if error.errno != errno.EADDRINUSE:
                    raise CheckFailed("ports_while_alive", "unexpected_bind_error") from None
            else:
                raise CheckFailed("ports_while_alive", "port_not_owned")
    if child.poll() is not None:
        raise CheckFailed("ports_while_alive", "child_exited")


def require_ports_released(ports):
    # Hold both new sockets simultaneously, then close both before the fresh run.
    with ExitStack() as sockets:
        for port in ports:
            probe = sockets.enter_context(socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                raise CheckFailed("ports_after_kill", "bind_failed") from None


def check(binary):
    started = time.monotonic()
    result = {
        "scenario": "local_awg_sigkill_restart",
        "holding_reached": False,
        "both_ports_busy_while_child_alive": False,
        "child_exit_is_sigkill": False,
        "both_ports_released_after_kill": False,
        "fresh_self_test_passed": False,
        "fresh_self_test_stopped": False,
        "cleanup_ok": True,
        "passed": False,
    }
    children = []
    try:
        if os.name != "posix":
            raise CheckFailed("platform", "posix_sigkill_required")
        try:
            executable = str(Path(binary).resolve(strict=True))
        except OSError:
            raise CheckFailed("binary", "missing") from None
        if not os.access(executable, os.X_OK):
            raise CheckFailed("binary", "not_executable")
        child = subprocess.Popen(
            [executable, "--self-test", "--hold", "30s"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
        )
        children.append(child)
        ports = wait_for_hold(child)
        result["holding_reached"] = True
        require_ports_busy(child, ports)
        result["both_ports_busy_while_child_alive"] = True
        if child.poll() is not None:
            raise CheckFailed("kill", "child_exited_before_signal")
        child.kill()  # POSIX SIGKILL to exactly this Popen child; never a process group.
        if child.wait(timeout=5) != -signal.SIGKILL:
            raise CheckFailed("kill", "unexpected_exit_status")
        result["child_exit_is_sigkill"] = True
        require_ports_released(ports)
        result["both_ports_released_after_kill"] = True

        fresh = subprocess.Popen(
            [executable, "--self-test"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        children.append(fresh)
        stdout, _ = fresh.communicate(timeout=45)
        if fresh.returncode != 0:
            raise CheckFailed("fresh_self_test", "nonzero_exit")
        try:
            report = json.loads(stdout)
        except (ValueError, UnicodeError):
            raise CheckFailed("fresh_self_test", "invalid_json") from None
        if not isinstance(report, dict) or report.get("mode") != "local_awg_self_test":
            raise CheckFailed("fresh_self_test", "invalid_json_shape")
        result["fresh_self_test_passed"] = report.get("passed") is True
        result["fresh_self_test_stopped"] = report.get("stopped") is True
        if not result["fresh_self_test_passed"] or not result["fresh_self_test_stopped"]:
            raise CheckFailed("fresh_self_test", "checks_failed")
    except CheckFailed as error:
        result["error_stage"], result["error_code"] = error.stage, error.code
    except subprocess.TimeoutExpired:
        result["error_stage"], result["error_code"] = "child_wait", "timeout"
    except Exception:
        result["error_stage"], result["error_code"] = "harness", "operation_failed"
    finally:
        for child in reversed(children):
            try:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=5)
            except Exception:
                result["cleanup_ok"] = False
            finally:
                for stream in (child.stdout, child.stderr):
                    if stream is not None:
                        stream.close()
        checks = (
            "holding_reached", "both_ports_busy_while_child_alive", "child_exit_is_sigkill",
            "both_ports_released_after_kill", "fresh_self_test_passed", "fresh_self_test_stopped", "cleanup_ok",
        )
        result["passed"] = "error_stage" not in result and all(result[name] for name in checks)
        result["duration_ms"] = round((time.monotonic() - started) * 1000)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, help="Path to the built awg-userspace-audit binary")
    parser.add_argument("--report", required=True, help="Path for a sanitized JSON result")
    args = parser.parse_args()
    result = check(args.binary)
    try:
        target = Path(args.report)
        if target.resolve() == Path(args.binary).resolve() or target.resolve() == Path(__file__).resolve():
            raise ValueError("report_path_conflict")
        target.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    except Exception:
        result["passed"] = False
        result["error_stage"], result["error_code"] = "report", "write_failed"
    print(json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
