import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import test from "node:test";

function moduleUnderTest() {
  const window = {};
  window.parent = window;
  const context = {
    window, document: { getElementById: () => null },
    location: { search: "" },
    Blob, DecompressionStream, TextDecoder, Uint8Array, Date, Intl, URLSearchParams, atob,
  };
  runInNewContext(readFileSync(new URL("../anr-loader.js", import.meta.url), "utf8"), context);
  return window.AnrAttribution;
}

function fixture(version = "2.2.15") {
  const longmsg = [
    "ANR in com.flow.mobile (com.flow.mobile/.MainActivity)",
    "Reason: Input dispatching timed out (Waited 5000ms for MotionEvent)",
    "CPU usage from 0ms to 1000ms later (2026-11-04 09:00:00.000 to 2026-11-04 09:00:01.000):",
    "  102% 5616/com.flow.mobile: 28% user + 73% kernel",
    "    55% 6142/AdWorker(Client: 30% user + 25% kernel",
    "    2% 6143/worker: 2% user + 0% kernel",
    "    1% 6144/idle: 1% user + 0% kernel",
    "   +0% 7839/AdWorker(Defaul: 0% user + 0% kernel",
  ].join("\n");
  const base64 = gzipSync(Buffer.from(JSON.stringify({ longmsg, main_stack: "main stack" }))).toString("base64");
  const chunks = base64.match(/.{1,80}/g);
  const common = { event_date: "2026-11-04", event_id: "event-1", event_timestamp: 1793800000000 };
  const payload = [
    { ...common, event_param_key: "anr_status", event_param_value: "captured" },
    { ...common, event_param_key: "device_ram_mb", event_param_value: "3450" },
    ...chunks.map((value, index) => ({ ...common, event_param_key: `anr_data_v1_${String(index).padStart(3, "0")}`, event_param_value: value })),
  ];
  const details = [{ ...common, platform: "Android",
    app_info_json: JSON.stringify({ id: "com.flow.mobile", version }),
    device_json: JSON.stringify({ operating_system_version: "16" }) }];
  return { payload, details };
}

test("decodes chunks and builds the ANR component and high CPU samples", async () => {
  const api = moduleUnderTest();
  const { payload, details } = fixture();
  const data = await api.build(payload, details);
  assert.equal(Object.keys(data.events).length, 1);
  assert.equal(data.events["event-1"].version, "verified");
  assert.equal(data.events["event-1"].ramBucket, "3to4");
  assert.equal(data.anrEvents["event-1"].activity, "com.flow.mobile.MainActivity");
  assert.equal(data.anrEvents["event-1"].trigger, "input");
  assert.deepEqual(Array.from(data.samples, row => row.cpu), [102, 55, 2]);
});

test("rejects a missing chunk and conflicting duplicate values", async () => {
  const api = moduleUnderTest();
  const { payload, details } = fixture();
  await assert.rejects(api.build(payload.filter(row => row.event_param_key !== "anr_data_v1_001"), details), /分片缺失/);
  await assert.rejects(api.build([...payload, { ...payload[0], event_param_value: "missing_main_stack" }], details), /参数 anr_status 冲突/);
});

test("excludes older verified versions and labels missing details as pending", async () => {
  const api = moduleUnderTest();
  const { payload, details } = fixture("2.2.14");
  assert.equal(Object.keys((await api.build(payload, details)).events).length, 0);
  assert.equal((await api.build(payload, [])).events["event-1"].version, "pending");
});

test("does not assign another app's generic coroutine thread to our app", () => {
  const api = moduleUnderTest();
  assert.equal(api.classify("thread", "DefaultDispatch", "com.flow.mobile")[0], "coroutine_worker");
  assert.equal(api.classify("thread", "DefaultDispatch", "com.dti.motorola")[0], "third_party_thread");
});


test("accepts four-part release versions at the supported cutoff", async () => {
  const api = moduleUnderTest();
  const current = fixture("2.2.16.2");
  const older = fixture("2.2.14.9");
  assert.equal((await api.build(current.payload, current.details)).meta.events, 1);
  assert.equal((await api.build(older.payload, older.details)).meta.events, 0);
});

test("CPU timeout shows a retry directly on the attribution board", async () => {
  const messages = [];
  const status = { hidden: true, append(_, button) { this.retry = button; }, after() {} };
  const elements = { anrLoadStatus: status };
  const window = {
    parent: { postMessage: payload => messages.push(payload) },
  };
  const timeout = new Error("aborted");
  timeout.name = "TimeoutError";
  runInNewContext(readFileSync(new URL("../anr-loader.js", import.meta.url), "utf8"), {
    window, URLSearchParams, AbortSignal,
    location: { search: "?date_start=2026-11-16&date_end=2026-11-22&view=cpu", origin: "https://example.com" },
    document: { getElementById: name => elements[name], createElement: () => ({}), querySelectorAll: () => [] },
    fetch: async (_, { signal }) => { assert.ok(signal); throw timeout; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(status.textContent, /CPU 预取读取超时/);
  assert.equal(status.retry.textContent, "重试 CPU 归因");
  assert.equal(messages.at(-1).phase, "unavailable");
});

test("cached body shards keep fingerprint validation and retry after a missing index", async () => {
  const window = {};
  window.parent = window;
  let fail = true;
  let indexCalls = 0;
  const body = { longmsg: "ANR in com.flow.mobile\nCPU usage from 0ms", main_stack: "main", association: "process_time_correlated" };
  const encoded = gzipSync(JSON.stringify(body)).toString("base64");
  const event = { event_id: "event-1", event_date: "2026-11-18", event_hour: 19, event_timestamp: 42,
    record_fingerprint: "correct", anr_status: "captured", record_kind: "canonical", chunk_count: 1 };
  const row = { ...event, event_params_json: JSON.stringify({ anr_data_v1_000: encoded }) };
  const values = {
    "2026-11-16_2026-11-22-bodies-index.json.gz": {
      schema: 1, dateStart: "2026-11-16", dateEnd: "2026-11-22",
      snapshotEtl: "2026-11-23 01:52:41", count: 1, events: { "event-1": "bodies-1234567890abcdef1234" },
    },
    "bodies-1234567890abcdef1234.json.gz": { "event-1": row },
  };
  runInNewContext(readFileSync(new URL("../anr-loader.js", import.meta.url), "utf8"), {
    window, document: { getElementById: () => null },
    location: { search: "?date_start=2026-11-16&date_end=2026-11-22" },
    URLSearchParams, AbortSignal, Blob, Response, DecompressionStream, TextDecoder, TextEncoder,
    Uint8Array, Date, Intl, atob,
    fetch: async url => {
      const name = url.split("/").at(-1).split("?")[0];
      if (name.includes("index")) { indexCalls++; if (fail) { fail = false; throw new Error("network"); } }
      return new Response(gzipSync(JSON.stringify(values[name])));
    },
  });
  window.AnrAttribution.connectSnapshot({ meta: { bodySource: "hourly_event_body",
    snapshot_etl: "2026-11-23 01:52:41" }, events: { "event-1": event } });
  await assert.rejects(window.readAnrBody("event-1"), /network/);
  assert.equal((await window.readAnrBody("event-1")).longmsg, body.longmsg);
  assert.equal(indexCalls, 2);
  row.record_fingerprint = "wrong";
  const second = { ...event, event_id: "event-2" };
  // Independent decode must continue rejecting mismatched records.
  await assert.rejects(window.AnrAttribution.decodeEvent([row], second), /标识不一致/);
});
