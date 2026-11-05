import json
import tempfile
import unittest
from pathlib import Path

from scripts.assemble_prefetch import normalize, validate_ws_totals
from scripts.prepare_prefetch import datasets_from_manifest, render


ROOT = Path(__file__).resolve().parents[1]


class PrefetchTest(unittest.TestCase):
    def test_inventory_and_parameter_rendering(self):
        datasets = datasets_from_manifest((ROOT / "manifest.yaml").read_text())
        self.assertEqual(len(datasets), 44)
        self.assertIn("anr_payload", datasets)
        sql, names = render(datasets["anr_payload"], {
            "date_start": "2026-11-03", "date_end": "2026-11-04",
            "use_date_end": 1, "jank_threshold": 10, "cold_threshold_ms": 2000,
        })
        self.assertIn("p.event_date >= '2026-11-03'", sql)
        self.assertIn("p.event_date <= '2026-11-04'", sql)
        self.assertEqual(names, ["date_end", "date_start", "use_date_end"])

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


if __name__ == "__main__":
    unittest.main()
