import assert from "node:assert/strict";
import test from "node:test";
import categories from "../anr-categories.js";
import { summarizeCpu } from "../scripts/summarize_anr_cpu.mjs";

test("app-owned media and GC threads keep an app primary class and a use label", () => {
  const { categoriesFor, summarizeCategories } = categories;
  const rows = [
    { eventId: "a", scope: "app", tag: "media_loader", name: "Loader:Extracto" },
    { eventId: "b", scope: "other", tag: "media_system", name: "mediaserver" },
    { eventId: "a", scope: "app", tag: "gc_heap", name: "HeapTaskDaemon" },
    { eventId: "c", scope: "other", tag: "coroutine_worker", parent: "com.dti.motorola", name: "DefaultDispatch" },
  ];
  for (const row of rows) {
    const result = categoriesFor(row);
    row.category = result.primary;
    row.categories = result.labels;
  }
  assert.equal(rows[0].category, "app");
  assert.deepEqual(Array.from(rows[0].categories), ["app", "media"]);
  assert.deepEqual(Array.from(rows[1].categories), ["media"]);
  assert.deepEqual(Array.from(rows[2].categories), ["app", "memory"]);
  assert.deepEqual(Array.from(rows[3].categories), ["third_party"]);
  const { primaryByCategory, byCategory } = summarizeCategories(rows);
  assert.equal([...primaryByCategory.values()].reduce((sum, item) => sum + item.samples, 0), 4);
  assert.equal(byCategory.get("app").samples, 2);
  assert.equal(byCategory.get("app").ids.size, 1);
  assert.equal(byCategory.get("media").samples, 2);
  assert.equal([...byCategory.values()].reduce((sum, item) => sum + item.samples, 0), 6);
});

test("CPU overview preserves event deduplication and uses the strict default threshold", () => {
  const sample = { scope: "app", tag: "media_loader", name: "ExoPlayer", eventId: "a" };
  const overview = summarizeCpu({ schema: 1, dateStart: "2026-11-16", dateEnd: "2026-11-22",
    data: { meta: { events: 2 }, events: { a: {}, b: {} },
      samples: [{ ...sample, cpu: 60 }, { ...sample, cpu: 51 }, { ...sample, eventId: "b", cpu: 50 }] } });
  assert.equal(overview.sampleCount, 2);
  assert.equal(overview.eventsAboveThreshold, 1);
  assert.deepEqual(overview.categories, [["app", 2]]);
});
