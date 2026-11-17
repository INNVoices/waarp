#!/usr/bin/env python3
"""Require actual passing JUnit results; an empty or skipped suite is not a gate."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    options = parser.parse_args()
    cases = []
    for path in sorted(options.results.rglob("TEST-*.xml")):
        for case in ET.parse(path).getroot().iter("testcase"):
            status = "failed" if case.find("failure") is not None or case.find("error") is not None else "skipped" if case.find("skipped") is not None else "passed"
            cases.append({"class": case.get("classname"), "name": case.get("name"), "seconds": float(case.get("time", "0")), "status": status})
    totals = {status: sum(case["status"] == status for case in cases) for status in ("passed", "failed", "skipped")}
    report = {"schemaVersion": 1, "checkedAtUtc": datetime.now(timezone.utc).isoformat(), "tests": len(cases), **totals, "summedTestSeconds": sum(case["seconds"] for case in cases), "cases": cases}
    options.report.parent.mkdir(parents=True, exist_ok=True)
    options.report.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Android JUnit: {len(cases)} tests, {totals['passed']} passed, {totals['failed']} failed, {totals['skipped']} skipped.")
    if not cases or totals["failed"] or totals["skipped"]:
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, ET.ParseError) as error:
        print(f"Invalid Android test report: {error}", file=sys.stderr)
        raise SystemExit(1)
