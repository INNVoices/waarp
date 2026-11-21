#!/usr/bin/env python3
"""Read and validate Waarp's production task map; never change GitHub or files."""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ROOT / "docs/production/tasks.json"
STATUSES = {"ready", "planned", "in_progress", "review", "blocked", "done", "deferred"}
TASK_ID = re.compile(r"[A-Z][A-Z0-9]*-[0-9]{3}\Z")


def spec_card(task):
    path, sep, anchor = task["spec"].partition("#")
    candidate = (ROOT / path).resolve()
    if not sep or not candidate.is_relative_to(ROOT) or not candidate.is_file():
        raise ValueError(f"{task['id']}: missing or unsafe local specification: {task['spec']}")
    if anchor != task["id"].lower():
        raise ValueError(f"{task['id']}: specification must use its exact task anchor")
    text = candidate.read_text(encoding="utf-8")
    pattern = rf"^### {re.escape(task['id'])}\s*\n(.*?)(?=^### |^## |\Z)"
    match = re.search(pattern, text, re.M | re.S)
    if not match:
        raise ValueError(f"{task['id']}: exact '### {task['id']}' heading not found")
    return match.group(0).strip()


def validate(data):
    errors = []
    if data.get("schema_version") != 1:
        errors.append("schema_version must be 1")
    tasks = data.get("tasks")
    corpora = data.get("corpora")
    if not isinstance(tasks, list) or not tasks or not isinstance(corpora, list):
        return errors + ["nonempty tasks and corpora arrays are required"]
    corps = {c.get("id"): c for c in corpora if isinstance(c, dict)}
    if len(corps) != len(corpora):
        errors.append("corpus IDs must be unique")
    by_id = {}
    for task in tasks:
        if not isinstance(task, dict):
            errors.append("each task must be an object")
            continue
        tid = task.get("id", "")
        if not isinstance(tid, str) or not TASK_ID.fullmatch(tid):
            errors.append(f"invalid task ID: {tid!r}")
            continue
        if tid in by_id:
            errors.append(f"duplicate task ID: {tid}")
        by_id[tid] = task
        for field in ("title", "lane", "scope", "acceptance", "verification", "spec"):
            if not isinstance(task.get(field), str) or not task[field].strip():
                errors.append(f"{tid}: nonempty {field} required")
        if task.get("corpus") not in corps:
            errors.append(f"{tid}: unknown corpus")
        if task.get("priority") not in {"P0", "P1", "P2"}:
            errors.append(f"{tid}: invalid priority")
        if task.get("status") not in STATUSES:
            errors.append(f"{tid}: invalid status")
        for field in ("depends_on", "conditional_dependencies", "external_blockers", "platforms", "work_paths", "evidence"):
            values = task.get(field)
            if not isinstance(values, list) or any(not isinstance(v, str) or not v for v in values):
                errors.append(f"{tid}: {field} must be an array of nonempty strings")
        if task.get("status") == "blocked" and not task.get("depends_on") and not task.get("external_blockers"):
            errors.append(f"{tid}: blocked task must name a dependency or external blocker")
        if task.get("status") == "done" and not task.get("evidence"):
            errors.append(f"{tid}: done task needs evidence")
        if isinstance(task.get("spec"), str):
            try:
                card = spec_card(task)
                status = re.search(r"\*\*status:\*\*\s*`?([a-z_]+)", card, re.I)
                if not status or status[1].lower() != task.get("status"):
                    errors.append(f"{tid}: card and registry statuses differ")
                priority = re.search(r"\*\*priority:\*\*\s*(P[012])", card, re.I)
                if not priority or priority[1].upper() != task.get("priority"):
                    errors.append(f"{tid}: card and registry priorities differ")
                for label, field in (("Dependencies", "depends_on"), ("Conditional dependencies", "conditional_dependencies")):
                    declaration = re.search(rf"\*\*{label}:\*\*\s*([^\n]*?)(?=\s+\*\*|\n|$)", card, re.I)
                    declared = re.findall(r"[A-Z][A-Z0-9]*-[0-9]{3}", declaration[1]) if declaration else []
                    if (field == "depends_on" and not declaration) or declared != task.get(field):
                        errors.append(f"{tid}: card and registry {label.lower()} differ")
            except (OSError, ValueError) as error:
                errors.append(str(error))
    for tid, task in by_id.items():
        for field in ("depends_on", "conditional_dependencies"):
            deps = task.get(field, [])
            if not isinstance(deps, list):
                continue
            if len(deps) != len(set(d for d in deps if isinstance(d, str))):
                errors.append(f"{tid}: duplicate or malformed {field}")
            for dep in deps:
                if not isinstance(dep, str) or dep not in by_id or dep == tid:
                    errors.append(f"{tid}: invalid dependency {dep!r}")
        deps = task.get("depends_on", [])
        if task.get("status") == "ready" and isinstance(deps, list):
            if any(by_id.get(d, {}).get("status") != "done" for d in deps if isinstance(d, str)) or task.get("external_blockers"):
                errors.append(f"{tid}: ready task has unresolved blockers")
    visiting, visited = set(), set()

    def visit(tid, trail):
        if tid in visiting:
            errors.append("dependency cycle: " + " -> ".join(trail + [tid]))
            return
        if tid in visited:
            return
        visiting.add(tid)
        deps = by_id[tid].get("depends_on", [])
        for dep in deps if isinstance(deps, list) else []:
            if isinstance(dep, str) and dep in by_id:
                visit(dep, trail + [tid])
        visiting.remove(tid)
        visited.add(tid)

    for tid in by_id:
        visit(tid, [])
    for corpus in corpora:
        if not isinstance(corpus, dict) or not isinstance(corpus.get("spec"), str):
            errors.append("each corpus needs a local specification")
            continue
        path = (ROOT / corpus["spec"]).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():
            errors.append(f"{corpus.get('id')}: missing or unsafe corpus specification")
            continue
        card_ids = re.findall(r"^### ([A-Z][A-Z0-9]*-[0-9]{3})\s*$", path.read_text(encoding="utf-8"), re.M)
        registry_ids = [tid for tid, task in by_id.items() if task.get("corpus") == corpus.get("id")]
        if sorted(card_ids) != sorted(registry_ids):
            errors.append(f"{corpus.get('id')}: corpus cards and registry IDs differ")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", type=Path, default=DEFAULT, help="Read another registry snapshot")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="Validate IDs, cards, statuses and dependency graph")
    ready = sub.add_parser("ready", help="List unclaimed tasks with completed hard dependencies")
    ready.add_argument("--lane")
    ready.add_argument("--limit", type=int, default=20)
    ready.add_argument("--json", action="store_true")
    show = sub.add_parser("show", help="Print one full task card and its current dependency states")
    show.add_argument("id")
    show.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        data = json.loads(args.registry.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("registry must be a JSON object")
        errors = validate(data)
    except (OSError, ValueError) as error:
        print(f"Invalid roadmap: {error}", file=sys.stderr)
        return 1
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    tasks = data["tasks"]
    by_id = {task["id"]: task for task in tasks}
    if args.command == "check":
        print(json.dumps({"valid": True, "tasks": len(tasks), "corpora": len(data["corpora"]),
                          "statuses": dict(Counter(t["status"] for t in tasks)),
                          "baseline": data["baseline_commit"]}, ensure_ascii=False))
    elif args.command == "ready":
        lanes = {task["lane"] for task in tasks}
        if args.limit < 1 or (args.lane and args.lane not in lanes):
            parser.error("positive limit and a known lane required; lanes: " + ", ".join(sorted(lanes)))
        selected = [task for task in tasks if task["status"] in {"ready", "planned"}
                    and not task["external_blockers"]
                    and all(by_id[dep]["status"] == "done" for dep in task["depends_on"])
                    and (not args.lane or task["lane"] == args.lane)]
        selected.sort(key=lambda task: (task["priority"], task["id"]))
        selected = selected[:args.limit]
        if args.json:
            print(json.dumps(selected, ensure_ascii=False, indent=2))
        else:
            print("Local snapshot only; confirm GitHub status and ownership before claiming.")
            for task in selected:
                print(f"{task['id']}  {task['priority']}  {task['lane']}  {task['title']}")
            if not selected:
                print("No unclaimed tasks meet the hard-dependency and external-blocker gates.")
    else:
        task = by_id.get(args.id.upper())
        if not task:
            parser.error("unknown task ID: " + args.id)
        if args.json:
            print(json.dumps(task, ensure_ascii=False, indent=2))
        else:
            print(f"{task['id']}: {task['title']}\nLane: {task['lane']} | Status: {task['status']}")
            print("Dependencies: " + (", ".join(f"{dep} ({by_id[dep]['status']})" for dep in task["depends_on"]) or "none"))
            if task["external_blockers"]:
                print("External blockers: " + "; ".join(task["external_blockers"]))
            if task["conditional_dependencies"]:
                print("Conditional gates (read card): " + ", ".join(task["conditional_dependencies"]))
            print("\n" + spec_card(task))
    return 0


if __name__ == "__main__":
    sys.exit(main())
