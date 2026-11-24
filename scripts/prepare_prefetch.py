"""Render every manifest dataset for the last seven completed Beijing dates.

The output is an input manifest for the 08:00 prefetch job. No credentials or data are
written to the repository; the job executes each SQL through DataSage and publishes a
complete snapshot only after every dataset has succeeded.
"""

import argparse
import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
PARAM = re.compile(r"(?<![\w:]):(date_start|date_end|use_date_end|jank_threshold|cold_threshold_ms|snapshot_etl|record_kind|cursor_event_timestamp|cursor_event_id|event_id|event_date|event_hour)\b")


def datasets_from_manifest(text):
    lines = text.splitlines()
    if "datasets:" not in lines:
        raise ValueError("manifest has no datasets")
    current = None
    reading_sql = False
    sql_lines = []
    output = {}

    def finish():
        if current:
            if not sql_lines:
                raise ValueError(f"dataset {current} has no SQL")
            output[current] = "\n".join(sql_lines).strip()

    for line in lines[lines.index("datasets:") + 1:]:
        dataset = re.fullmatch(r"  ([a-z][a-z0-9_]*):", line)
        if dataset:
            finish()
            current = dataset.group(1)
            reading_sql = False
            sql_lines = []
            continue
        if current and line == "    sql: |":
            reading_sql = True
            continue
        if reading_sql:
            if line.startswith("      "):
                sql_lines.append(line[6:])
            elif not line.strip():
                sql_lines.append("")
            else:
                reading_sql = False
    finish()
    return output


def render(sql, params):
    used = set()

    def replace(match):
        name = match.group(1)
        used.add(name)
        value = params[name]
        if isinstance(value, str):
            return "'" + value.replace("'", "''") + "'"
        return str(value)

    rendered = PARAM.sub(replace, sql)
    if PARAM.search(rendered):
        raise ValueError("unresolved manifest parameter")
    return rendered, sorted(used)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", help="Beijing calendar date, YYYY-MM-DD; defaults to today")
    parser.add_argument("--days", type=int, choices=range(1, 8), default=7)
    parser.add_argument("--snapshot-etl", help="Validated ANR summary watermark for first-page caches")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date() if not args.as_of else datetime.strptime(args.as_of, "%Y-%m-%d").date()
    params = {"date_start": str(today - timedelta(days=args.days)), "date_end": str(today - timedelta(days=1)),
              "use_date_end": 1, "jank_threshold": 10, "cold_threshold_ms": 2000}
    watermark = "9999-12-31 23:59:59"
    if args.snapshot_etl:
        watermark = datetime.strptime(args.snapshot_etl, "%Y-%m-%d %H:%M:%S").strftime("%Y-%m-%d %H:%M:%S")
    defaults = {"snapshot_etl": "9999-12-31 23:59:59", "record_kind": "all",
                "cursor_event_timestamp": 0, "cursor_event_id": "", "event_id": "",
                "event_date": params["date_end"], "event_hour": 0}
    source = datasets_from_manifest((ROOT / "manifest.yaml").read_text(encoding="utf-8"))
    if len(source) < 44 or "anr_payload" not in source or "anr_details" not in source:
        raise ValueError("manifest dataset inventory is incomplete")
    queries = {name: {"sql": render(sql, {**params, **defaults})[0], "params": render(sql, {**params, **defaults})[1]}
               for name, sql in source.items()}
    if args.snapshot_etl:
        for kind in ("all", "canonical", "candidate"):
            sql, used = render(source["anr_page"], {
                **params, **defaults, "snapshot_etl": watermark, "record_kind": kind,
            })
            queries[f"anr_page_{kind}"] = {"sql": sql, "params": used}
    core = ("crash_overview", "crash_daily", "crash_breakdown", "crash_by_version", "crash_by_model",
            "anr_summary", "anr_payload", "anr_details")
    if any(name not in queries for name in core):
        raise ValueError("Core stability or ANR dataset missing")
    output = {"schema_version": 1, **params, "priority_order": list(core) + [name for name in queries if name not in core],
              "datasets": queries}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"date_start": params["date_start"], "date_end": params["date_end"],
                      "datasets": len(queries), "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
