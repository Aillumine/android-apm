import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import test from "node:test";

function moduleUnderTest() {
  const status = { textContent: "", hidden: false };
  const window = {};
  window.parent = window;
  const context = {
    window, document: { getElementById: () => status },
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
  assert.deepEqual(Array.from(data.samples, row => row.cpu), [102, 55]);
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
