#!/usr/bin/env python3
"""Ensure editing the task map cannot silently remove a documented release gate."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("roadmap", Path(__file__).with_name("production-roadmap.py"))
roadmap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(roadmap)
BASELINE = json.loads(roadmap.DEFAULT.read_text(encoding="utf-8"))


class TaskContractTests(unittest.TestCase):
    def snapshot(self):
        data = deepcopy(BASELINE)
        return data, {task["id"]: task for task in data["tasks"]}

    def test_real_map_is_consistent(self):
        self.assertEqual(roadmap.validate(BASELINE), [])

    def test_removing_a_documented_hard_gate_is_rejected(self):
        data, tasks = self.snapshot()
        self.assertIn("NET-001", tasks["NET-002"]["depends_on"])
        tasks["NET-002"]["depends_on"].remove("NET-001")
        self.assertTrue(any("NET-002: card and registry dependencies differ" in e for e in roadmap.validate(data)))

    def test_conditional_observer_gate_cannot_disappear(self):
        data, tasks = self.snapshot()
        self.assertIn("STK-004", tasks["STK-005"]["conditional_dependencies"])
        tasks["STK-005"]["conditional_dependencies"].remove("STK-004")
        self.assertTrue(any("STK-005: card and registry conditional dependencies differ" in e for e in roadmap.validate(data)))

    def test_cycle_is_rejected(self):
        data, tasks = self.snapshot()
        tasks["NET-002"]["depends_on"] = ["NET-003"]
        tasks["NET-003"]["depends_on"] = ["NET-002"]
        self.assertTrue(any("dependency cycle" in e for e in roadmap.validate(data)))

    def test_card_cannot_vanish_from_registry(self):
        data, _ = self.snapshot()
        data["tasks"] = [task for task in data["tasks"] if task["id"] != "STK-007"]
        self.assertTrue(any("corpus cards and registry IDs differ" in e for e in roadmap.validate(data)))


if __name__ == "__main__":
    unittest.main()
