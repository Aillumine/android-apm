import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { gzipSync } from "node:zlib";

function cacheWith(snapshot) {
  const window = {};
  const fetch = async () => ({ ok: true, body: new Blob([gzipSync(JSON.stringify(snapshot))]).stream() });
  runInNewContext(readFileSync(new URL("../prefetch-cache.js", import.meta.url), "utf8"),
    { window, fetch, Blob, DecompressionStream, Response });
  return window.ApmPrefetch;
}

test("all sections are covered by the exact seven-day snapshot", async () => {
  const seed = cacheWith(null);
  const names = Object.values(seed.sections).flat();
  assert.equal(new Set(names).size, 44);
  const snapshot = { schema_version: 1, generated_at: "2026-11-05T08:00:00+08:00",
    date_start: "2026-10-29", date_end: "2026-11-04", jank_threshold: 10,
    cold_threshold_ms: 2000,
    datasets: Object.fromEntries(names.map(name => [name, { columns: [], rows: [] }])) };
  const cache = cacheWith(snapshot);
  assert.equal(await cache.load(), true);
  for (const section of Object.keys(cache.sections)) {
    assert.equal(cache.covers(section, { date_start: snapshot.date_start, date_end: snapshot.date_end,
      use_date_end: 1 }), true, section);
  }
  assert.equal(cache.lookup(["anr_payload", "anr_details"], {
    date_start: "2026-11-02", date_end: "2026-11-04", use_date_end: 1,
  }), null);
  assert.equal(cache.lookup(["frame_overview"], {
    date_start: snapshot.date_start, date_end: snapshot.date_end, use_date_end: 1, jank_threshold: 20,
  }), null);
});

test("partial snapshot cannot claim a section is ready", async () => {
  const cache = cacheWith({ schema_version: 1, generated_at: "2026-11-05T08:00:00+08:00",
    date_start: "2026-11-03", date_end: "2026-11-04", jank_threshold: 10,
    cold_threshold_ms: 2000, complete: false, missing_datasets: ["crash_daily"],
    datasets: { crash_overview: { rows: [] } } });
  await cache.load();
  assert.equal(cache.info().complete, false);
  assert.deepEqual(Array.from(cache.info().missing), ["crash_daily"]);
  assert.equal(cache.covers("stability", { date_start: "2026-11-03", date_end: "2026-11-04", use_date_end: 1 }), false);
});
