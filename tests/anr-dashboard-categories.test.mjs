import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

function helpers() {
  const source = readFileSync(new URL("../anr-dashboard.js", import.meta.url), "utf8");
  const context = {};
  runInNewContext(source.slice(0, source.indexOf("const $ =")), context);
  return context;
}

test("app-owned media and GC threads keep an app primary class and a use label", () => {
  const { categoriesFor, summarizeCategories } = helpers();
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
