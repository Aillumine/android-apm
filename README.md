# Emochi Android APM

DataSage dashboard for Android quality metrics. The `ANR归因` entry is the second sidebar item and opens `anr-dashboard.html` inside the existing app. The page reads `anr_payload` and `anr_details` for the selected dates, validates and decompresses the uploaded longMsg chunks, and keeps records without event-detail versions visibly pending. It groups CPU samples above the selected threshold and displays the original longMsg on demand.

Every App-owned CPU row has `本 App 进程与线程` as its primary category. A specialized purpose such as media loading, GC, rendering, or diagnostics is retained as a second label and can appear in both category filters. Pie slices count only the primary category once per CPU row; category bars allow overlap and their percentages must not be added together. Generic thread names in another process are never treated as App-owned solely because of their name.

## Default dates and daily prefetch

The default range is the previous seven completed Beijing calendar dates. At 08:00 Asia/Shanghai, Codex automation `emochi-android-apm` renders **all 44** manifest datasets with `scripts/prepare_prefetch.py`. It queries stability first and assembles a snapshot as soon as all five stability datasets are ready. It then attempts ANR and the remaining sections, storing results under the isolated `prefetch/runs/YYYYMMDD/results/` directory with a hash of each rendered SQL. If an expanded snapshot exceeds the size limit, the last published verified snapshot remains available. An incomplete snapshot has `complete=false` and an explicit missing-dataset list. The browser uses the snapshot for covered sections and queries the others live. Missing rows are never fabricated or mixed with files from another date.

The browser fetches the compressed `prefetch/latest.json.gz` snapshot once at startup. A matching default range and thresholds render from the snapshot; a custom range, changed threshold, or manual “运行查询” uses live DataSage queries. The ANR page reuses the same snapshot through the parent dashboard. If the prior day's event-detail partition is not yet available at 08:00, the ANR page marks those versions and Android system values as pending instead of inventing them.

Resource bounds for the existing tabs are explicit: FPS/memory and WS duration percentiles use a deterministic 1% `event_id` sample while availability and WS counts remain full counts. The payment `pay_step` duration query excludes the very large `catalog_load` event; the catalog success, failure, and skipped counts come from `pay_daily`. For multi-day WS snapshots, `scripts/merge_daily_ws.py` can combine complete one-day exports, and `assemble_prefetch.py` requires their counts to match the independent `ws_overview` totals.

```bash
python3 scripts/prepare_prefetch.py --output prefetch/runs/YYYYMMDD/queries.json
# Execute every rendered SQL with DataSage and save each complete result with
# query_sha256 under prefetch/runs/YYYYMMDD/results/<dataset>.json.
python3 scripts/assemble_prefetch.py \
  --queries prefetch/runs/YYYYMMDD/queries.json \
  --results prefetch/runs/YYYYMMDD/results \
  --output prefetch/latest.json
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
