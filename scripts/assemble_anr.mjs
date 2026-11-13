import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import { join } from "node:path";

const [start, end, output, ...runs] = process.argv.slice(2);
if (!output || !runs.length || ![start, end].every(day => /^\d{4}-\d{2}-\d{2}$/.test(day))) {
  throw new Error("Usage: node scripts/assemble_anr.mjs START END OUTPUT RUN_DIR [RUN_DIR...]");
}
const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const window = {};
window.parent = window;
runInNewContext(await readFile(new URL("../anr-loader.js", import.meta.url), "utf8"), {
  window, location: { search: "" }, document: { getElementById: () => ({}) },
  URLSearchParams, Blob, DecompressionStream, TextDecoder, Uint8Array, Intl, Date, atob,
});
const inputs = new Map();
for (const run of runs) {
  const queries = await readJson(join(run, "queries.json"));
  for (const name of ["anr_payload", "anr_details"]) {
    const result = await readJson(join(run, "results", name + ".json"));
    const rows = result.rows ?? result.data;
    const hash = createHash("sha256").update(queries.datasets[name].sql).digest("hex");
    if (result.error || result.truncated !== false || !Array.isArray(rows) ||
        rows.length !== Number(result.row_count) || result.query_sha256 !== hash ||
        (result.status != null && !["success", "completed"].includes(result.status))) {
      throw new Error(`Unverified result: ${run}/${name}`);
    }
    for (let time = Date.parse(queries.date_start); time <= Date.parse(queries.date_end); time += 86400000) {
      const day = new Date(time).toISOString().slice(0, 10);
      if (day >= start && day <= end) {
        if (!inputs.has(day)) inputs.set(day, {});
        inputs.get(day)[name] = [];
      }
    }
    for (const row of rows) {
      const value = Array.isArray(row) ? Object.fromEntries(result.columns.map((key, index) => [key, row[index]])) : row;
      const day = String(value.event_date).slice(0, 10);
      if (day < queries.date_start || day > queries.date_end) throw new Error(`Unexpected result date: ${day}`);
      if (day >= start && day <= end) inputs.get(day)[name].push(value);
    }
  }
}
const data = { events: {}, anrEvents: {}, samples: [] };
await mkdir(output, { recursive: true });
const writeGzip = async (name, value) => {
  const bytes = gzipSync(JSON.stringify(value));
  if (bytes.length > 45 * 1024 * 1024) throw new Error(`Compressed asset too large: ${name}`);
  await writeFile(join(output, name + ".json.gz"), bytes);
  return bytes.length;
};
let originalBytes = 0;
for (let time = Date.parse(start); time <= Date.parse(end); time += 86400000) {
  const day = new Date(time).toISOString().slice(0, 10);
  const input = inputs.get(day);
  if (!input?.anr_payload || !input?.anr_details) throw new Error(`Missing verified date: ${day}`);
  const daily = await window.AnrAttribution.build(input.anr_payload, input.anr_details);
  const ids = Object.keys(daily.events);
  for (let offset = 0; offset < ids.length; offset += 100) {
    const originals = {};
    const group = ids.slice(offset, offset + 100);
    for (const id of group) originals[id] = daily.events[id].longmsg;
    const digest = createHash("sha256").update(JSON.stringify(originals)).digest("hex").slice(0, 16);
    const shard = `longmsg-${day}-${digest}`;
    originalBytes += await writeGzip(shard, originals);
    for (const id of group) {
      const { longmsg, ...metadata } = daily.events[id];
      if (Object.hasOwn(data.events, id)) throw new Error(`Duplicate event across dates: ${id}`);
      data.events[id] = { ...metadata, shard };
    }
  }
  Object.assign(data.anrEvents, daily.anrEvents);
  for (const sample of daily.samples) data.samples.push(sample);
}
data.meta = { events: Object.keys(data.events).length, samples: data.samples.length };
const summaryBytes = await writeGzip(`${start}_${end}`, { schema: 1, dateStart: start, dateEnd: end, data });
console.log(JSON.stringify({ ...data.meta, summaryBytes, originalBytes }));
