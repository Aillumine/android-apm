import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import categories from "../anr-categories.js";

export function summarizeCpu(snapshot) {
  const { dateStart, dateEnd, data } = snapshot;
  const { meta, events, samples } = data;
  if (snapshot.schema !== 1 || Number(meta.events) !== Object.keys(events).length) {
    throw new Error("Invalid CPU snapshot");
  }
  const counts = new Map();
  const matchedEvents = new Set();
  let sampleCount = 0;
  for (const row of samples) {
    if (row.cpu <= 50) continue;
    if (!Object.hasOwn(events, row.eventId)) throw new Error("CPU sample references an unknown event");
    const { primary } = categories.categoriesFor(row);
    counts.set(primary, (counts.get(primary) ?? 0) + 1);
    matchedEvents.add(row.eventId);
    sampleCount++;
  }
  return {
    schema: 1, dateStart, dateEnd, threshold: 50, events: Number(meta.events),
    eventsAboveThreshold: matchedEvents.size, sampleCount,
    categories: [...counts].sort((a, b) => b[1] - a[1]),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("Usage: summarize_anr_cpu.mjs SNAPSHOT.gz OVERVIEW.json");
  const snapshot = JSON.parse(gunzipSync(await readFile(input)));
  await writeFile(output, JSON.stringify(summarizeCpu(snapshot)));
}
