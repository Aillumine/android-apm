"""Convert a DataSage headerless CSV export into the dashboard result contract."""

import argparse
import csv
import hashlib
import json
import re
from pathlib import Path


def result_columns(sql):
    match = list(re.finditer(r"(?m)^SELECT\b", sql, re.IGNORECASE))
    if not match:
        raise ValueError("Outer SELECT not found")
    tail = sql[match[-1].end():]
    outer = re.split(r"(?m)^FROM\b", tail, maxsplit=1, flags=re.IGNORECASE)[0]
    outer = re.sub(r"(?m)--.*$", "", outer)
    expressions = []
    current = []
    depth = 0
    quote = False
    for char in outer:
        if char == "'":
            quote = not quote
        elif not quote:
            if char == "(": depth += 1
            elif char == ")": depth -= 1
            elif char == "," and depth == 0:
                expressions.append("".join(current).strip())
                current = []
                continue
        current.append(char)
    expressions.append("".join(current).strip())
    names = []
    for expr in expressions:
        alias = re.search(r"\bAS\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*$", expr, re.IGNORECASE)
        simple = re.fullmatch(r"(?:[a-zA-Z_][\w]*\.)?([a-zA-Z_][\w]*)", expr)
        if not alias and not simple:
            raise ValueError(f"Column alias missing: {expr[-80:]}")
        names.append((alias or simple).group(1))
    if len(names) != len(set(names)):
        raise ValueError("Duplicate result columns")
    return names


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--queries", type=Path, required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--expected-rows", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    queries = json.loads(args.queries.read_text(encoding="utf-8"))["datasets"]
    sql = queries[args.dataset]["sql"]
    columns = result_columns(sql)
    with args.csv.open(encoding="utf-8-sig", newline="") as stream:
        records = list(csv.reader(stream))
    if records and records[0] == columns:
        records.pop(0)
    if len(records) != args.expected_rows:
        raise ValueError(f"Incomplete export: {len(records)} / {args.expected_rows}")
    if any(len(record) != len(columns) for record in records):
        raise ValueError("Export column count mismatch")
    rows = [dict(zip(columns, [cell if cell != "" else None for cell in record])) for record in records]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"status": "success", "columns": columns, "rows": rows,
                                       "row_count": len(rows), "truncated": False,
                                       "query_sha256": hashlib.sha256(sql.encode("utf-8")).hexdigest()}, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"dataset": args.dataset, "columns": columns, "rows": len(rows)}))


if __name__ == "__main__":
    main()
