/* Build the ANR attribution view from the two DataSage datasets. */
(() => {
  "use strict";

  const MAX_BODY = 112 * 1024;
  const params = new URLSearchParams(location.search);
  const requestId = params.get("request_id") || "";
  const dateStart = params.get("date_start");
  const dateEnd = params.get("date_end");
  const status = document.getElementById("anrLoadStatus");

  function tellParent(error) {
    if (window.parent !== window) {
      window.parent.postMessage({ source: "android-apm-anr", requestId, error: error || "" }, location.origin);
    }
  }

  function rowsOf(dataset) {
    if (!dataset || !Array.isArray(dataset.rows)) throw new Error("ANR 数据集未返回完整行");
    if (!dataset.rows.length || !Array.isArray(dataset.rows[0])) return dataset.rows;
    return dataset.rows.map(row => Object.fromEntries(dataset.columns.map((key, index) => [key, row[index]])));
  }

  function required(value, name) {
    if (value === null || value === undefined || value === "") throw new Error(`缺少 ${name}`);
    return String(value);
  }

  async function decode(chunks) {
    const indexes = [...chunks.keys()].sort((a, b) => a - b);
    if (!indexes.length || indexes.length > 100 || indexes.some((index, position) => index !== position)) {
      throw new Error("ANR 正文分片缺失或不连续");
    }
    const base64 = indexes.map(index => {
      const part = chunks.get(index);
      if (part.length > 900) throw new Error("ANR 正文分片过大");
      return part;
    }).join("");
    const binary = atob(base64);
    const compressed = Uint8Array.from(binary, character => character.charCodeAt(0));
    const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    const parts = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) {
          await reader.cancel();
          throw new Error("ANR 正文超过上限");
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const raw = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { raw.set(part, offset); offset += part.length; }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (!body || typeof body.longmsg !== "string" || !body.longmsg.trim()) {
      throw new Error("ANR 正文缺少 longMsg");
    }
    return body;
  }

  function component(value) {
    const slash = value.indexOf("/");
    if (slash < 0) return value;
    const name = value.slice(slash + 1);
    return name.startsWith(".") ? value.slice(0, slash) + name : name;
  }

  function bucket(mb) {
    if (mb == null) return "unknown";
    if (mb < 2048) return "lt2";
    if (mb < 3072) return "2to3";
    if (mb < 4096) return "3to4";
    if (mb < 6144) return "4to6";
    return "ge6";
  }

  function isSupportedVersion(value) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value || "");
    if (!match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    return major > 2 || (major === 2 && (minor > 2 || (minor === 2 && patch >= 15)));
  }

  function classify(kind, name, parent) {
    const lower = name.toLowerCase(), owner = parent.toLowerCase();
    if (kind === "process") {
      if (name === "com.flow.mobile") return ["app_main", "主进程高 CPU"];
      if (lower.startsWith("com.flow.mobile:")) return ["app_sub", "本 App 子进程"];
      if (/^(kswapd|kcompactd|tdefrag)/.test(lower)) return ["memory_reclaim", "内核内存回收"];
      if (name === "system_server") return ["system_service", "Android 系统服务"];
      if (lower.startsWith("com.google.android.gms")) return ["google_service", "Google 服务"];
      if (lower.includes("webview") || lower.includes("chrome")) return ["webview", "WebView／浏览器"];
      if (/^(android\.hardware\.media|media\.|audioserver|mediaserver)/.test(lower)) return ["media_system", "媒体系统进程"];
      if (/^(kworker|migration\/|irq\/|rcu_|exe_cq)/.test(lower)) return ["kernel_work", "内核工作线程"];
      if (/^(com\.|org\.|ai\.)/.test(lower)) return ["third_party_process", "第三方应用进程"];
      return ["other_process", "其他进程"];
    }
    if (["Signal Catcher", "AnrConsumer", "AnrAuxiliaryTas"].includes(name)) return ["anr_diagnostics", "ANR 取证线程"];
    if (["HeapTaskDaemon", "FinalizerDaemon"].includes(name)) return ["gc_heap", "GC／堆管理"];
    if (name === "com.flow.mobile" && owner.startsWith("com.flow.mobile")) return ["main_thread", "主线程"];
    if (/^(RenderThread|Chrome_|CrRenderer|Compositor)/.test(name)) return ["graphics", "图形／WebView 渲染"];
    if (/^(Loader:Extract|ExoPlayer|MediaCodec|CodecLooper)/.test(name)) return ["media_loader", "媒体加载／解码"];
    if (owner.startsWith("com.flow.mobile") && name.startsWith("ChatPool")) return ["chat_worker", "聊天后台任务"];
    if (owner.startsWith("com.flow.mobile") && name.startsWith("DefaultDispatch")) return ["coroutine_worker", "协程后台任务"];
    if (owner.startsWith("com.flow.mobile") && name.startsWith("arch_disk_io")) return ["disk_io", "AndroidX 磁盘任务"];
    if (owner.startsWith("com.flow.mobile") && name.startsWith("default_npth")) return ["apm_worker", "APM 诊断线程（疑似）"];
    if (/^(AdWorker|AppLovinSdk|Fyber|Pangle)/.test(name)) return ["ad_worker", "广告 SDK 工作线程"];
    if (owner.startsWith("com.flow.mobile") && (lower.includes(".com/...") || lower.includes(".io/..."))) return ["network_worker", "网络请求线程（疑似）"];
    if (owner.startsWith("com.flow.mobile")) return ["other_app_thread", "本 App 其他线程"];
    if (owner === "system_server") return ["system_thread", "系统服务线程"];
    if (/^(com\.|org\.|ai\.)/.test(owner)) return ["third_party_thread", "第三方应用线程"];
    return ["other_thread", "其他线程"];
  }

  function anrInfo(longmsg) {
    const lines = longmsg.split("\n");
    const reason = (lines.find(line => line.startsWith("Reason: ")) || "").slice(8).trim();
    const header = /^ANR in \S+? \(([^)]+)\)/.exec(lines[0] || "");
    const activityRaw = header ? header[1] : "";
    const info = { reason, activityRaw, activity: component(activityRaw), broadcastAction: "",
      broadcastReceiverRaw: "", broadcastReceiver: "", serviceRaw: "", serviceName: "", inputSubtype: "" };
    if (reason.startsWith("Input dispatching timed out")) {
      info.trigger = "input";
      const lower = reason.toLowerCase();
      info.inputSubtype = lower.includes("does not have a focused window") || lower.includes("no focused window") ? "无焦点窗口"
        : reason.includes("MotionEvent") ? "触摸事件 MotionEvent"
        : reason.includes("FocusEvent") ? "焦点事件 FocusEvent"
        : reason.includes("KeyEvent") ? "按键事件 KeyEvent" : "其他输入事件";
    } else if (reason.startsWith("Broadcast of Intent")) {
      info.trigger = "broadcast";
      info.broadcastAction = /\bact=([^\s}]+)/.exec(reason)?.[1] || "未提供 action";
      info.broadcastReceiverRaw = /\bcmp=([^\s}]+)/.exec(reason)?.[1] || "";
      info.broadcastReceiver = info.broadcastReceiverRaw ? component(info.broadcastReceiverRaw) : "未提供 receiver";
    } else if (reason.startsWith("executing service") || reason.startsWith("Timed out while trying to bind")) {
      info.trigger = "service";
      info.serviceRaw = /executing service ([^\s,]+)/.exec(reason)?.[1] || "";
      info.serviceName = info.serviceRaw ? component(info.serviceRaw) : "绑定超时：未提供 Service 类名";
    } else if (reason.startsWith("No response to onStartJob") || reason.startsWith("No response to onStopJob")) {
      info.trigger = "job";
      info.serviceName = reason.includes("onStartJob") ? "JobService.onStartJob：未提供类名" : "JobService.onStopJob：未提供类名";
    } else if (reason.toLowerCase().includes("focus window timeout")) {
      info.trigger = "window";
    } else if (reason.startsWith("Process ProcessRecord") && reason.includes("failed to complete startup")) {
      info.trigger = "startup";
    } else {
      info.trigger = "other";
    }
    return info;
  }

  function cpuSamples(eventId, event) {
    const samples = [], lines = event.longmsg.split("\n");
    const report = /Android time\s*:\s*\[([\d-]+ [\d:.]+)\]/.exec(event.longmsg)?.[1];
    const reportTime = report ? Date.parse(report.replace(" ", "T")) : NaN;
    let block = -1, header = "", parent = "", durationMs = 0, relation = "无法对时";
    for (const line of lines) {
      const h = /^CPU usage from (-?\d+)ms to (-?\d+)ms (ago|later)(?: \((.*?) to (.*?)\))?/.exec(line);
      if (h) {
        block++;
        header = line;
        parent = "";
        durationMs = h[3] === "ago" ? Number(h[1]) - Number(h[2]) : Number(h[2]) - Number(h[1]);
        const start = h[4] ? Date.parse(h[4].replace(" ", "T")) : NaN;
        const end = h[5] ? Date.parse(h[5].replace(" ", "T")) : NaN;
        relation = Number.isFinite(reportTime) && Number.isFinite(start) && Number.isFinite(end)
          ? end <= reportTime ? "报告前" : start >= reportTime ? "报告后" : "跨报告时间" : "无法对时";
        continue;
      }
      if (block < 0) continue;
      const process = /^  \+?(\d+(?:\.\d+)?)%\s+(\d+)\/(.+?):\s+(?=\d+(?:\.\d+)?%\s+(?:user|kernel)\b)/.exec(line);
      const thread = /^    \+?(\d+(?:\.\d+)?)%\s+(\d+)\/(.+?):\s+(?=\d+(?:\.\d+)?%\s+(?:user|kernel)\b)/.exec(line);
      if (process) parent = process[3];
      const entry = process || thread;
      if (!entry || Number(entry[1]) <= 50) continue;
      const kind = process ? "process" : "thread";
      const owner = process ? "" : parent;
      const [tag, tagName] = classify(kind, entry[3], owner);
      samples.push({ eventId, date: event.date,
        eventTime: new Date(event.eventMs).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T") + "+08:00",
        version: event.version, kind, scope: (owner || entry[3]).includes("com.flow.mobile") ? "app" : "other",
        parent: owner, name: entry[3], cpu: Number(entry[1]), pidTid: entry[2], block,
        durationMs, blockHeader: header, relation, raw: line.trim(), reason: anrInfo(event.longmsg).reason,
        tag, tagName });
    }
    return samples;
  }

  async function build(payloadRows, detailRows) {
    const groups = new Map(), detail = new Map();
    for (const row of payloadRows) {
      const id = required(row.event_id, "event_id");
      const timestamp = Number(required(row.event_timestamp, "event_timestamp"));
      const date = required(row.event_date, "event_date").slice(0, 10);
      if (!Number.isFinite(timestamp)) throw new Error(`事件 ${id} 时间戳无效`);
      if (!groups.has(id)) groups.set(id, { date, timestamp, values: new Map() });
      const group = groups.get(id);
      if (group.timestamp !== timestamp) throw new Error(`事件 ${id} 时间戳冲突`);
      if (date < group.date) group.date = date;
      const key = required(row.event_param_key, "event_param_key");
      const value = required(row.event_param_value, "event_param_value");
      if (group.values.has(key) && group.values.get(key) !== value) throw new Error(`事件 ${id} 参数 ${key} 冲突`);
      group.values.set(key, value);
    }
    if (groups.size > 5000) throw new Error("ANR 事件超过单次加载上限，请缩小日期区间");
    for (const row of detailRows) {
      const id = String(row.event_id || "");
      if (!groups.has(id) || !row.app_info_json || row.platform !== "Android") continue;
      const app = JSON.parse(row.app_info_json), device = JSON.parse(row.device_json || "{}");
      if (app.id !== "com.flow.mobile") continue;
      if (Number(row.event_timestamp) !== groups.get(id).timestamp) throw new Error(`事件 ${id} 明细时间戳冲突`);
      const metadata = { appVersion: app.version || null,
        osVersion: String(device.operating_system_version || "unknown").match(/^\d+/)?.[0] || "unknown" };
      if (detail.has(id) && JSON.stringify(detail.get(id)) !== JSON.stringify(metadata)) throw new Error(`事件 ${id} 明细冲突`);
      detail.set(id, metadata);
    }
    const events = {}, samples = [], anrEvents = {};
    for (const [id, group] of groups) {
      const status = group.values.get("anr_status");
      if (!["captured", "missing_main_stack"].includes(status)) continue;
      const chunks = new Map();
      for (const [key, value] of group.values) {
        const match = /^anr_data_v1_(\d{3})$/.exec(key);
        if (match) chunks.set(Number(match[1]), value);
      }
      const body = await decode(chunks);
      if (status === "captured" && (typeof body.main_stack !== "string" || !body.main_stack.trim())) throw new Error(`事件 ${id} 主线程栈缺失`);
      if (status === "missing_main_stack" && typeof body.main_stack === "string" && body.main_stack.trim()) throw new Error(`事件 ${id} 状态与主线程栈不符`);
      const metadata = detail.get(id);
      if (metadata?.appVersion && !isSupportedVersion(metadata.appVersion)) continue;
      const ramRaw = group.values.get("device_ram_mb");
      const ram = /^\d+$/.test(ramRaw || "") ? Number(ramRaw) : null;
      const event = { longmsg: body.longmsg, date: group.date, eventMs: group.timestamp,
        version: metadata?.appVersion ? "verified" : "pending", status,
        appVersion: metadata?.appVersion || null, osVersion: metadata?.osVersion || "unknown",
        ramMb: ram, ramBucket: bucket(ram) };
      events[id] = event;
      anrEvents[id] = anrInfo(body.longmsg);
      samples.push(...cpuSamples(id, event));
    }
    samples.sort((a, b) => a.eventTime.localeCompare(b.eventTime) || a.eventId.localeCompare(b.eventId) || a.block - b.block || b.cpu - a.cpu);
    return { meta: { events: Object.keys(events).length, samples: samples.length }, events, samples, anrEvents };
  }

  async function start() {
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStart || "") || !/^\d{4}-\d{2}-\d{2}$/.test(dateEnd || "")) {
        throw new Error("日期参数无效，请从主看板进入");
      }
      if (window.parent === window || typeof window.parent.queryDatasets !== "function") {
        throw new Error("请从 Android APM 主看板打开 ANR 归因页");
      }
      const result = await window.parent.queryDatasets(["anr_payload", "anr_details"], {
        date_start: dateStart, date_end: dateEnd, use_date_end: 1,
      });
      const data = await build(rowsOf(result.anr_payload), rowsOf(result.anr_details));
      window.DATA = data;
      document.getElementById("anrFoot").textContent = `${dateStart} 至 ${dateEnd}，按 event_id 去重。${data.meta.events} 条 longMsg；超过 50% CPU 的采样行 ${data.meta.samples} 条。事件明细尚未就绪的记录标记为“版本待核验”，不构造缺失正文。`;
      status.hidden = true;
      const script = document.createElement("script");
      script.src = "anr-dashboard.js";
      script.onload = () => tellParent("");
      script.onerror = () => { status.textContent = "归因图表脚本加载失败"; tellParent(status.textContent); };
      document.body.append(script);
    } catch (error) {
      status.textContent = `ANR 数据加载失败：${error.message}`;
      tellParent(error.message);
    }
  }

  window.AnrAttribution = { build, anrInfo, cpuSamples, classify, decode };
  start();
})();
