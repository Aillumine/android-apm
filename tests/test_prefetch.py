import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.assemble_prefetch import normalize, validate_ws_totals
from scripts.prepare_prefetch import datasets_from_manifest, render


ROOT = Path(__file__).resolve().parents[1]


class PrefetchTest(unittest.TestCase):
    def test_inventory_and_parameter_rendering(self):
        datasets = datasets_from_manifest((ROOT / "manifest.yaml").read_text())
        self.assertEqual(len(datasets), 47)
        self.assertIn("anr_payload", datasets)
        sql, names = render(datasets["anr_payload"], {
            "date_start": "2026-11-03", "date_end": "2026-11-04",
            "use_date_end": 1, "jank_threshold": 10, "cold_threshold_ms": 2000,
        })
        self.assertIn("p.event_date >= '2026-11-03'", sql)
        self.assertIn("p.event_date <= '2026-11-04'", sql)
        self.assertEqual(names, ["date_end", "date_start", "use_date_end"])

    def test_source_cutover_is_disjoint_and_bounded(self):
        datasets = datasets_from_manifest((ROOT / "manifest.yaml").read_text())
        for name, sql in datasets.items():
            if "ods_original.ods_clickstream_app_event_" not in sql:
                continue
            self.assertIn("ods_clickstream_app_event_v2_hi", sql, name)
            self.assertRegex(sql, r"event_date >= (?:DATE )?'2026-11-10'", name)
            if "ods_clickstream_app_event_di" in sql or "ods_clickstream_app_event_parameter_hi" in sql:
                self.assertRegex(sql, r"event_date (?:< (?:DATE )?'2026-11-10'|<= (?:DATE )?'2026-11-09')", name)
            self.assertNotIn("{{", sql, name)

    def test_incomplete_result_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "incomplete result"):
            normalize({"columns": ["n"], "rows": [[1]], "row_count": 2}, "x")
        with self.assertRaisesRegex(ValueError, "truncated"):
            normalize({"columns": [], "rows": [], "truncated": True}, "x")
        self.assertEqual(normalize({"columns": ["n"], "rows": [[1]], "row_count": 1}, "x")["rows"], [{"n": 1}])

    def test_ws_daily_merge_must_reconcile_with_overview(self):
        data = {
            "ws_overview": {"rows": [{"attempts": 4, "successes": 2, "errors": 1, "stalled": 1, "disconnects": 3}]},
            "ws_reason": {"rows": [{"event_name": "ws_connect_error", "cnt": 1},
                                   {"event_name": "ws_disconnect", "cnt": 3}]},
            "ws_vpn_split": {"rows": [{"attempts": 4, "successes": 2, "errors": 1, "stalled": 1}]},
        }
        validate_ws_totals(data)
        data["ws_reason"]["rows"][0]["cnt"] = 2
        with self.assertRaisesRegex(ValueError, "reason total mismatch"):
            validate_ws_totals(data)

    def test_zero_launch_snapshot_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            run = Path(temp) / "20261119"
            results = run / "results"
            results.mkdir(parents=True)
            sql = "SELECT 0 AS launches"
            queries = run / "queries.json"
            queries.write_text(json.dumps({
                "date_end": "2026-11-18", "datasets": {"crash_overview": {"sql": sql}},
            }))
            (results / "crash_overview.json").write_text(json.dumps({
                "rows": [{"launches": 0}], "query_sha256": hashlib.sha256(sql.encode()).hexdigest(),
            }))
            output = run / "latest.json"
            result = subprocess.run(["python3", str(ROOT / "scripts/assemble_prefetch.py"),
                "--queries", str(queries), "--results", str(results), "--output", str(output),
                "--allow-partial"], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("refusing to publish an empty snapshot", result.stderr)
            self.assertFalse(output.exists())

    def test_partial_snapshot_is_labeled_and_bound_to_run_sql(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            queries = root / "runs/20261106/queries.json"
            results = queries.parent / "results"
            results.mkdir(parents=True)
            query = {"date_start": "2026-11-04", "date_end": "2026-11-05",
                     "jank_threshold": 10, "cold_threshold_ms": 2000,
                     "datasets": {"a": {"sql": "SELECT 1 AS n"}, "b": {"sql": "SELECT 2 AS n"}}}
            queries.write_text(json.dumps(query))
            (results / "a.json").write_text(json.dumps({"columns": ["n"], "rows": [[1]], "row_count": 1,
                "query_sha256": hashlib.sha256(b"SELECT 1 AS n").hexdigest()}))
            output = root / "latest.json"
            cmd = ["python3", str(ROOT / "scripts/assemble_prefetch.py"), "--queries", str(queries),
                   "--results", str(results), "--output", str(output)]
            self.assertNotEqual(subprocess.run(cmd, capture_output=True).returncode, 0)
            subprocess.run(cmd + ["--allow-partial"], check=True, capture_output=True)
            snapshot = json.loads(output.read_text())
            self.assertFalse(snapshot["complete"])
            self.assertEqual(snapshot["missing_datasets"], ["b"])
            self.assertEqual(snapshot["datasets"]["a"]["rows"], [{"n": 1}])
            query["datasets"]["a"]["sql"] = "SELECT 3 AS n"
            queries.write_text(json.dumps(query))
            self.assertNotEqual(subprocess.run(cmd + ["--allow-partial"], capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()
