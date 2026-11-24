# Emochi Android APM

DataSage dashboard for Android quality metrics. ANR attribution opens with a small diagnostic summary and the first event page. Each event body is queried and decoded on demand. The high CPU overview is generated from the corresponding CPU snapshot at the default threshold of 50%. Follow the date-labeled link for CPU filters and full sample details.

Every App-owned CPU row has `本 App 进程与线程` as its primary category. A specialized purpose such as media loading, GC, rendering, or diagnostics is retained as a second label and can appear in both category filters. Pie slices count only the primary category once per CPU row; category bars allow overlap and their percentages must not be added together. Generic thread names in another process are never treated as App-owned solely because of their name.

## Default dates and daily prefetch

The default range is the previous seven completed Beijing calendar dates. At 08:00 Asia/Shanghai, the scheduled task first prepares the five stability datasets and `anr_summary`. Re-run `scripts/prepare_prefetch.py` with the summary's `--snapshot-etl` to render the three first-page queries against that same watermark. Save validated results and their SQL hashes under `prefetch/runs/YYYYMMDD/results/`. Publish the light snapshot first. Publish the CPU snapshot and its overview independently once all referenced shards are verified.

The browser loads `prefetch/latest.json.gz` with a timeout. If the latest seven-day cache is unavailable, the home page can use the most recent confirmed summary with its actual dates. The CPU overview and details identify their covered dates separately. Select a new range to query that range. CPU details show a retry and summary link if the full snapshot cannot be read.

The scheduled executor needs approved DataSage query and publish access. If an unattended run denies a required approval, retain the last confirmed snapshot and record the run as failed. Confirm scheduled recovery from a run that generates and publishes a new date range and serves it on the production page.

Resource bounds for the existing tabs are explicit: FPS/memory and WS duration percentiles use a deterministic 1% `event_id` sample while availability and WS counts remain full counts. The payment `pay_step` duration query excludes the very large `catalog_load` event; the catalog success, failure, and skipped counts come from `pay_daily`. For multi-day WS snapshots, `scripts/merge_daily_ws.py` can combine complete one-day exports, and `assemble_prefetch.py` requires their counts to match the independent `ws_overview` totals.

```bash
python3 scripts/prepare_prefetch.py --output prefetch/runs/YYYYMMDD/queries.json
# Execute the stability and summary queries and validate the result rows.
# Re-render first-page queries with --snapshot-etl before executing them.
# Save verified results with query_sha256 in the run results directory.
python3 scripts/assemble_prefetch.py \
  --queries prefetch/runs/YYYYMMDD/queries.json \
  --results prefetch/runs/YYYYMMDD/results \
  --allow-partial --output prefetch/latest.json
```

The raw snapshot contains ANR traces. `.gitignore` excludes it and all query/export outputs; do not commit them to this public repository. Upload it only as an authenticated DataSage report asset.

## Development and checks

The separate development report is [android-apm-anr-dev](https://datasage.flow.chat/r/u369/android-apm-anr-dev). Its manifest ID and `app.js` slug are rewritten in the upload bundle; the repository keeps the production `android-apm` slug. Deployment must include **all** static files because DataSage upload replaces the whole artifact. Verify the upload with `verify_upload(depth="medium")` and check the actual report page; SQL syntax validation alone does not prove runtime queries will finish.

```bash
node --check app.js
node --check anr-loader.js
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```
