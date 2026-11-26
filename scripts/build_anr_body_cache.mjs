import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import { join } from "node:path";

const [snapshotPath, rowsPath, outputDir] = process.argv.slice(2);
if (!outputDir) throw new Error("Usage: node scripts/build_anr_body_cache.mjs SNAPSHOT.gz ROWS.json OUTPUT_DIR");
const snapshot = JSON.parse(gunzipSync(await readFile(snapshotPath)));
const input = JSON.parse(await readFile(rowsPath, "utf8"));
if (!Array.isArray(input.rows) || input.truncated !== false || input.rows.length !== input.row_count) {
  throw new Error("Incomplete ANR body query result");
}
const events = snapshot.data.events;
const expectedIds = Object.keys(events);
if (snapshot.schema !== 1 || snapshot.data.meta.bodySource !== "hourly_event_body" ||
    snapshot.data.meta.events !== expectedIds.length || !snapshot.data.meta.snapshot_etl) {
  throw new Error("Invalid CPU snapshot metadata");
}
const window = {};
window.parent = window;
runInNewContext(await readFile(new URL("../anr-loader.js", import.meta.url), "utf8"), {
  window, location: { search: "" }, document: { getElementById: () => null },
  URLSearchParams, Blob, DecompressionStream, TextDecoder, TextEncoder, Uint8Array, Intl, Date, atob,
});
const rows = new Map();
for (const row of input.rows) {
  const event = events[row.event_id];
  if (!event || row.record_fingerprint !== event.record_fingerprint) continue;
  if (rows.has(row.event_id)) {
    if (JSON.stringify(rows.get(row.event_id)) !== JSON.stringify({ ...row, record_kind: event.record_kind })) {
      throw new Error(`Conflicting matching record: ${row.event_id}`);
    }
    continue;
  }
  rows.set(row.event_id, { ...row, record_kind: event.record_kind });
}
const missing = expectedIds.filter(id => !rows.has(id));
if (missing.length) throw new Error(`Missing ${missing.length} exact ANR body records`);
await mkdir(outputDir, { recursive: true });
const index = {};
for (let offset = 0; offset < expectedIds.length; offset += 100) {
  const shardRows = {};
  for (const id of expectedIds.slice(offset, offset + 100)) {
    const row = rows.get(id);
    await window.AnrAttribution.decodeEvent([row], events[id]);
    shardRows[id] = row;
  }
  const content = JSON.stringify(shardRows);
  const shard = `bodies-${createHash("sha256").update(content).digest("hex").slice(0, 20)}`;
  await writeFile(join(outputDir, shard + ".json.gz"), gzipSync(content));
  for (const id of Object.keys(shardRows)) index[id] = shard;
}
const result = { schema: 1, dateStart: snapshot.dateStart, dateEnd: snapshot.dateEnd,
  snapshotEtl: snapshot.data.meta.snapshot_etl, count: expectedIds.length, events: index };
const output = join(outputDir, `${snapshot.dateStart}_${snapshot.dateEnd}-bodies-index.json.gz`);
const temp = output + ".tmp";
await writeFile(temp, gzipSync(JSON.stringify(result)));
await rename(temp, output);
console.log(JSON.stringify({ events: expectedIds.length, shards: new Set(Object.values(index)).size }));
