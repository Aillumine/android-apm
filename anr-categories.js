(function (global) {
  "use strict";
  const CATEGORY = {
    app: {name: "本 App 进程与线程", color: "#0061A4", description: "本 App 的全部进程和线程；用途标签可与本类重复"},
    memory: {name: "内存回收与 GC", color: "#006A6A", description: "内核内存回收和运行时堆管理；两者是线索，不等于已证实内存根因"},
    system: {name: "系统与平台服务", color: "#6750A4", description: "Android 系统服务、服务线程及 Google 平台服务"},
    diagnostics: {name: "ANR 取证活动", color: "#A15C00", description: "Signal Catcher 等系统或应用的诊断线程；采样可能发生在 ANR 之后"},
    third_party: {name: "第三方应用", color: "#B3261E", description: "其他应用的进程及其线程"},
    webview: {name: "WebView 与图形", color: "#386A20", description: "WebView、浏览器及渲染线程"},
    media: {name: "媒体处理", color: "#7D5260", description: "媒体服务与加载、解码线程；本 App 线程也会同时列在本 App 类"},
    kernel: {name: "其他内核工作", color: "#4F616E", description: "未划入内存回收的内核工作线程"},
    other: {name: "其他或未分类", color: "#5F5F5F", description: "现有名称不足以可靠归入上述类别的进程或线程"}
  };
  const RAW_TO_CATEGORY = {
    app_main: "app", app_sub: "app", main_thread: "app", chat_worker: "app",
    coroutine_worker: "app", disk_io: "app", apm_worker: "app",
    network_worker: "app", other_app_thread: "app",
    memory_reclaim: "memory", gc_heap: "memory",
    system_service: "system", system_thread: "system", google_service: "system",
    anr_diagnostics: "diagnostics",
    third_party_process: "third_party", third_party_thread: "third_party",
    webview: "webview", graphics: "webview",
    media_system: "media", media_loader: "media",
    ad_worker: "app", kernel_work: "kernel",
    other_process: "other", other_thread: "other"
  };
  function categoriesFor(row) {
    const specialty = RAW_TO_CATEGORY[row.tag];
    if (!specialty) throw Error("Unmapped source tag: " + row.tag);
    if (row.scope === "app") return { primary: "app", labels: specialty === "app" ? ["app"] : ["app", specialty] };
    if (specialty === "app") {
      const owner = (row.parent || row.name || "").toLowerCase();
      const primary = owner === "system_server" ? "system" : /^(com\.|org\.|ai\.)/.test(owner) ? "third_party" : "other";
      return { primary, labels: [primary] };
    }
    return { primary: specialty, labels: [specialty] };
  }
  function summarizeCategories(rows) {
    const primaryByCategory = new Map(), byCategory = new Map();
    function add(target, category, eventId) {
      if (!target.has(category)) target.set(category, { samples: 0, ids: new Set() });
      target.get(category).samples++;
      target.get(category).ids.add(eventId);
    }
    for (const row of rows) {
      add(primaryByCategory, row.category, row.eventId);
      row.categories.forEach(category => add(byCategory, category, row.eventId));
    }
    return { primaryByCategory, byCategory };
  }
  const api = { CATEGORY, categoriesFor, summarizeCategories };
  if (typeof module === "object") module.exports = api;
  else global.AnrCategories = api;
})(globalThis);
