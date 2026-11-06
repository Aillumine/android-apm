"""Fail-closed assembly of a daily snapshot from all DataSage result files."""

import argparse
import gzip
import hashlib
import json
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


def normalize(source, name):
    if source.get("status") in ("failed", "cancelled") or source.get("error") or source.get("truncated"):
        raise ValueError(f"{name}: query failed or truncated")
    columns = source.get("columns") or []
    rows = source.get("rows", source.get("data"))
    if not isinstance(rows, list):
        raise ValueError(f"{name}: rows missing")
    if rows and isinstance(rows[0], list):
        if len(columns) != len(rows[0]):
            raise ValueError(f"{name}: columns mismatch")
        rows = [dict(zip(columns, row)) for row in rows]
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError(f"{name}: invalid row")
    count = source.get("row_count")
    if count is not None and int(count) != len(rows):
        raise ValueError(f"{name}: incomplete result {len(rows)} / {count}")
    return {"columns": columns or list(rows[0]) if rows else columns, "rows": rows, "row_count": len(rows)}


def validate_ws_totals(datasets):
    overview = datasets["ws_overview"]["rows"]
    if not overview:
        raise ValueError("WS overview is empty")
    source = overview[0]
    reason_rows = datasets["ws_reason"]["rows"]
    vpn_rows = datasets["ws_vpn_split"]["rows"]
    for event_name, column in (("ws_connect_error", "errors"), ("ws_disconnect", "disconnects")):
        count = sum(int(row["cnt"]) for row in reason_rows if row["event_name"] == event_name)
        if count != int(source[column]):
            raise ValueError(f"WS reason total mismatch for {event_name}: {count} / {source[column]}")
    for column in ("attempts", "successes", "errors", "stalled"):
        count = sum(int(row[column]) for row in vpn_rows)
        if count != int(source[column]):
            raise ValueError(f"WS VPN total mismatch for {column}: {count} / {source[column]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--queries", type=Path, required=True)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--allow-partial", action="store_true", help="Publish only verified datasets and label the snapshot incomplete")
    args = parser.parse_args()
    query = json.loads(args.queries.read_text(encoding="utf-8"))
    run_date = (date.fromisoformat(query["date_end"]) + timedelta(days=1)).strftime("%Y%m%d")
    if args.results.parent.name != run_date or args.results.name != "results":
        raise ValueError(f"Expected isolated results directory prefetch/runs/{run_date}/results")
    datasets = {}
    missing = []
    for name in query["datasets"]:
        path = args.results / f"{name}.json"
        if not path.exists():
            missing.append(name)
            continue
        source = json.loads(path.read_text(encoding="utf-8"))
        expected_hash = hashlib.sha256(query["datasets"][name]["sql"].encode("utf-8")).hexdigest()
        if source.get("query_sha256") != expected_hash:
            raise ValueError(f"{name}: result SQL does not match this morning's query")
        datasets[name] = normalize(source, name)
    if missing and not args.allow_partial:
        raise ValueError(f"Missing dataset results: {', '.join(missing)}")
    if {"ws_overview", "ws_reason", "ws_vpn_split"}.issubset(datasets):
        validate_ws_totals(datasets)
    snapshot = {"schema_version": 1, "generated_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
                "date_start": query["date_start"], "date_end": query["date_end"],
                "jank_threshold": query["jank_threshold"], "cold_threshold_ms": query["cold_threshold_ms"],
                "complete": not missing, "missing_datasets": missing, "datasets": datasets}
    body = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    if len(body.encode("utf-8")) > 45 * 1024 * 1024:
        raise ValueError("Snapshot exceeds 45 MiB; no partial data was published")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(body, encoding="utf-8")
    compressed = gzip.compress(body.encode("utf-8"), compresslevel=6, mtime=0)
    compressed_path = args.output.with_suffix(args.output.suffix + ".gz")
    compressed_temp = compressed_path.with_suffix(compressed_path.suffix + ".tmp")
    compressed_temp.write_bytes(compressed)
    os.replace(temporary, args.output)
    os.replace(compressed_temp, compressed_path)
    print(json.dumps({"datasets": len(datasets), "missing": missing, "date_start": snapshot["date_start"],
                      "date_end": snapshot["date_end"], "bytes": len(body.encode("utf-8")),
                      "gzip_bytes": len(compressed),
                      "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
