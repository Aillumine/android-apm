"""Combine consecutive one-day WS aggregates without averaging percentages."""

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path


def merge_reason(days):
    counts = Counter()
    for source in days:
        for row in source["rows"]:
            counts[(row["event_name"], row["reason"])] += int(row["cnt"])
    totals = Counter()
    for (event_name, _), count in counts.items():
        totals[event_name] += count
    return [{"event_name": event_name, "reason": reason, "cnt": count,
             "share": round(count / totals[event_name], 6) if totals[event_name] else None}
            for (event_name, reason), count in sorted(counts.items(), key=lambda item: (item[0][0], -item[1], item[0][1]))]


def merge_vpn(days):
    fields = ("attempts", "successes", "errors", "stalled")
    counts = defaultdict(lambda: Counter())
    for source in days:
        for row in source["rows"]:
            for field in fields:
                counts[row["vpn_state"]][field] += int(row[field] or 0)
    rows = []
    for state, values in counts.items():
        attempts = values["attempts"]
        rows.append({"vpn_state": state, **{field: values[field] for field in fields},
                     "connect_success_rate": round(values["successes"] / attempts, 6) if attempts else None,
                     "error_rate": round(values["errors"] / attempts, 6) if attempts else None})
    return sorted(rows, key=lambda row: -row["attempts"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", choices=("ws_reason", "ws_vpn_split"), required=True)
    parser.add_argument("--day", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if len(set(path.resolve() for path in args.day)) != len(args.day):
        raise ValueError("Daily input files must be distinct")
    sources = [json.loads(path.read_text(encoding="utf-8")) for path in args.day]
    if any(source.get("truncated") or len(source["rows"]) != source["row_count"] for source in sources):
        raise ValueError("Incomplete daily result")
    rows = merge_reason(sources) if args.dataset == "ws_reason" else merge_vpn(sources)
    columns = list(rows[0]) if rows else sources[0]["columns"]
    args.output.write_text(json.dumps({"status": "success", "columns": columns, "rows": rows,
                                       "row_count": len(rows), "truncated": False}, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"dataset": args.dataset, "rows": len(rows)}))


if __name__ == "__main__":
    main()
