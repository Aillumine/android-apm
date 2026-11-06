const CATEGORY = {
  app: {name: "本 App 进程与线程", color: "#0061A4", description: "本 App 的全部进程和线程；用途标签可与本类重复"},
  memory: {name: "内存回收与 GC", color: "#006A6A", description: "内核内存回收和运行时堆管理；两者是线索，不等于已证实内存根因"},
  system: {name: "系统与平台服务", color: "#6750A4", description: "Android 系统服务、服务线程及 Google 平台服务"},
  diagnostics: {name: "ANR 取证活动", color: "#A15C00", description: "Signal Catcher 等系统或应用的诊断线程；采样可能发生在 ANR 之后"},
  third_party: {name: "第三方应用", color: "#B3261E", description: "其他应用的进程及其线程"},
  webview: {name: "WebView 与图形", color: "#386A20", description: "WebView、浏览器及渲染线程"},
  media: {name: "媒体处理", color: "#7D5260", description: "媒体服务与加载、解码线程；本 App 线程也会同时列在本 App 类"},
  ads: {name: "广告工作线程", color: "#8E4D00", description: "明确命名为广告工作线程的采样行"},
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
  ad_worker: "ads", kernel_work: "kernel",
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
const $ = id => document.getElementById(id);
let selected = null;
let detailRows = [];
let detailOffset = 0;
for (const row of DATA.samples) {
  const membership = categoriesFor(row);
  row.category = membership.primary;
  row.categories = membership.labels;
}

function categoryInfo(key) { return CATEGORY[key]; }
function badge(key) {
  const b = document.createElement("span");
  b.className = "badge";
  b.textContent = categoryInfo(key).name;
  b.style.background = categoryInfo(key).color + "22";
  b.style.color = categoryInfo(key).color;
  return b;
}
function appendMarked(parent, value, needle) {
  const text = value || "";
  if (!needle) { parent.append(document.createTextNode(text)); return; }
  const lower = text.toLowerCase(), query = needle.toLowerCase();
  let offset = 0, position;
  while ((position = lower.indexOf(query, offset)) >= 0) {
    parent.append(document.createTextNode(text.slice(offset, position)));
    const mark = document.createElement("mark");
    mark.className = "hot";
    mark.textContent = text.slice(position, position + needle.length);
    parent.append(mark);
    offset = position + needle.length;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}
function population() {
  const version = $("version").value, ram = $("ram").value, os = $("os").value;
  return Object.keys(DATA.events).filter(id => {
    const event = DATA.events[id];
    return (version === "all" || event.version === version)
      && (ram === "all" || event.ramBucket === ram)
      && (os === "all" || event.osVersion === os);
  });
}
function threshold() {
  const value = Number($("thresholdNumber").value);
  return Number.isFinite(value) ? Math.max(50, Math.min(450, value)) : 50;
}
function qualifying(allowed) {
  const ids = new Set(allowed), kind = $("kind").value, scope = $("scope").value, min = threshold();
  return DATA.samples.filter(row => ids.has(row.eventId) && row.cpu > min
    && (kind === "all" || row.kind === kind)
    && (scope === "all" || row.scope === scope));
}
function entityKey(row) { return row.kind + "\u0000" + row.parent + "\u0000" + row.name; }
function percent(value, total) {
  if (!total) return "0%";
  const result = value * 100 / total;
  return (result < 0.1 ? result.toFixed(2) : result.toFixed(1)) + "%";
}
function setCategory(key) {
  $("tag").value = $("tag").value === key ? "all" : key;
  const expanded = $("tag").value !== "all";
  $("entitySection").open = expanded;
  selected = null;
  $("clear").hidden = true;
  $("detailList").replaceChildren();
  renderDetails(true);
  render();
  if (expanded) $("entitySection").scrollIntoView({behavior: "smooth", block: "start"});
}
function renderPie(rows, byCategory) {
  const total = rows.length;
  const groups = [...byCategory.entries()].sort((a, b) => b[1].samples - a[1].samples || a[0].localeCompare(b[0]));
  let start = 0;
  const stops = groups.map(([key, item], index) => {
    const end = index === groups.length - 1 ? 100 : start + item.samples * 100 / total;
    const stop = `${categoryInfo(key).color} ${start}% ${end}%`;
    start = end;
    return stop;
  });
  const pie = $("pie");
  pie.style.background = total ? `conic-gradient(${stops.join(",")})` : "#e8eef4";
  pie.setAttribute("aria-label", total ? "高 CPU 来源占比，从高到低：" + groups.map(([key, item]) => `${categoryInfo(key).name} ${percent(item.samples, total)}`).join("，") : "当前筛选没有高 CPU 采样行");
  $("pieTotal").textContent = total.toLocaleString();
}
function renderCategoryBars(rows, byCategory, eventCount) {
  const total = rows.length;
  const groups = [...byCategory.entries()].sort((a, b) => b[1].samples - a[1].samples || a[0].localeCompare(b[0]));
  const max = groups.length ? groups[0][1].samples : 1;
  $("categoryMeta").textContent = `${total.toLocaleString()} 条 CPU 采样行超过 ${threshold()}%，涉及 ${new Set(rows.map(row => row.eventId)).size} / ${eventCount} 条 ANR；本 App 线程可同时带用途标签，分类柱状图的占比不能相加。饼图按唯一主类计数，柱长按最高类别缩放。点击类别筛选名称列表。`;
  const container = $("categoryBars");
  container.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "当前筛选没有超过阈值的 CPU 采样行";
    container.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const [key, item] of groups) {
    const button = document.createElement("button"), label = document.createElement("span"), dot = document.createElement("span"), name = document.createElement("span"), track = document.createElement("span"), fill = document.createElement("span"), value = document.createElement("span"), count = document.createElement("small");
    button.className = "categoryrow" + ($("tag").value === key ? " active" : "");
    button.title = categoryInfo(key).description + "；点击筛选下方名称列表";
    label.className = "categoryname"; dot.className = "categorydot"; dot.style.background = categoryInfo(key).color;
    name.textContent = categoryInfo(key).name;
    label.append(dot, name);
    track.className = "categorytrack"; fill.className = "categoryfill";
    fill.style.width = item.samples * 100 / max + "%";
    fill.style.background = categoryInfo(key).color;
    track.append(fill);
    value.className = "categoryvalue"; value.textContent = percent(item.samples, total);
    count.textContent = `${item.samples.toLocaleString()} 行 · ${item.ids.size} ANR`;
    value.append(count);
    button.append(label, track, value);
    button.onclick = () => setCategory(key);
    fragment.append(button);
  }
  container.append(fragment);
}
const TRIGGER = {
  input: "输入分发超时", job: "JobService 回调超时", broadcast: "广播处理超时",
  service: "Service 执行或绑定超时", window: "窗口切换超时",
  startup: "进程启动超时", other: "其他系统报告原因"
};
const ANR_COLOR = {
  anrTypes: "#6750A4", inputTypes: "#0061A4", activityNames: "#386A20",
  broadcastActions: "#B3261E", broadcastReceivers: "#A15C00", serviceNames: "#006A6A"
};
let selectedAnr = null, anrRows = [], anrOffset = 0;
function groupAnr(ids, readName) {
  const groups = new Map();
  for (const id of ids) {
    const name = readName(DATA.anrEvents[id]);
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(id);
  }
  return [...groups.entries()].map(([name, eventIds]) => ({name, ids: eventIds}))
    .sort((a, b) => b.ids.length - a.ids.length || a.name.localeCompare(b.name, "zh"));
}
function renderAnrBars(chartId, noteId, groups, denominator, total, note) {
  const container = $(chartId);
  container.replaceChildren();
  $(noteId).textContent = `${denominator} 条相关 ANR，占当前 ${total} 条的 ${percent(denominator, total)}。${note || ""}`;
  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "当前筛选没有对应事件";
    container.append(empty);
    return;
  }
  const max = Math.max(...groups.map(item => item.ids.length));
  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    const button = document.createElement("button"), name = document.createElement("span"), track = document.createElement("span"), fill = document.createElement("span"), value = document.createElement("span"), small = document.createElement("small");
    button.className = "anrrow" + (selectedAnr?.chartId === chartId && selectedAnr.name === group.name ? " active" : "");
    name.className = "anrname"; name.textContent = group.name;
    track.className = "anrtrack"; fill.className = "anrfill";
    fill.style.width = group.ids.length * 100 / max + "%";
    fill.style.background = ANR_COLOR[chartId];
    track.append(fill);
    value.className = "anrvalue"; value.textContent = group.ids.length;
    small.textContent = percent(group.ids.length, denominator);
    value.append(small);
    button.append(name, track, value);
    button.title = "点击查看对应事件与完整 longMsg";
    button.onclick = () => {
      selectedAnr = {chartId, name: group.name, ids: group.ids};
      $("anrClear").hidden = false;
      renderAnrCharts(population());
      $("anrDetails").scrollIntoView({behavior: "smooth", block: "start"});
    };
    fragment.append(button);
  }
  container.append(fragment);
}
function renderAnrCharts(ids) {
  const input = ids.filter(id => DATA.anrEvents[id].trigger === "input");
  const broadcast = ids.filter(id => DATA.anrEvents[id].trigger === "broadcast");
  const service = ids.filter(id => ["service", "job"].includes(DATA.anrEvents[id].trigger));
  const activities = ids.filter(id => DATA.anrEvents[id].activity);
  renderAnrBars("anrTypes", "anrTypesNote", groupAnr(ids, e => TRIGGER[e.trigger]), ids.length, ids.length, "每条事件只归入一种触发类型。");
  renderAnrBars("inputTypes", "inputTypesNote", groupAnr(input, e => e.inputSubtype), input.length, ids.length, "按 Reason 中的输入事件名细分。");
  renderAnrBars("activityNames", "activityNamesNote", groupAnr(activities, e => e.activity), activities.length, ids.length, `${ids.length - activities.length} 条未提供关联 Activity。`);
  renderAnrBars("broadcastActions", "broadcastActionsNote", groupAnr(broadcast, e => e.broadcastAction), broadcast.length, ids.length, "同一广播事件在本图只出现一次。");
  renderAnrBars("broadcastReceivers", "broadcastReceiversNote", groupAnr(broadcast, e => e.broadcastReceiver), broadcast.length, ids.length, "未提供 receiver 的事件不推断接收方。");
  renderAnrBars("serviceNames", "serviceNamesNote", groupAnr(service, e => e.serviceName), service.length, ids.length, "Job 回调和绑定超时未给出具体类名时单列缺失项。");
  if (selectedAnr) {
    const allowed = new Set(ids);
    anrRows = selectedAnr.ids.filter(id => allowed.has(id));
    renderAnrDetails(true);
  }
}
function anrNeedle(event, chartId) {
  if (chartId === "activityNames") return event.activityRaw;
  if (chartId === "broadcastActions") return event.broadcastAction.startsWith("未提供") ? "" : event.broadcastAction;
  if (chartId === "broadcastReceivers") return event.broadcastReceiverRaw;
  if (chartId === "serviceNames") return event.serviceRaw || (event.reason.includes("onStartJob") ? "onStartJob" : event.reason.includes("onStopJob") ? "onStopJob" : "Timed out while trying to bind");
  if (chartId === "inputTypes") return event.inputSubtype.includes("MotionEvent") ? "MotionEvent" : event.inputSubtype.includes("FocusEvent") ? "FocusEvent" : event.inputSubtype.includes("KeyEvent") ? "KeyEvent" : "focused window";
  return event.reason.split("(")[0].trim();
}
function renderAnrDetails(reset) {
  if (reset) { $("anrDetailList").replaceChildren(); anrOffset = 0; }
  if (!selectedAnr) {
    $("anrDetailMeta").textContent = "点击上方柱子查看事件与完整 longMsg。";
    $("anrMore").hidden = true;
    return;
  }
  $("anrDetailMeta").textContent = `${selectedAnr.name}：${anrRows.length} 条去重 ANR`;
  const fragment = document.createDocumentFragment(), slice = anrRows.slice(anrOffset, anrOffset + 50);
  for (const id of slice) {
    const event = DATA.events[id], parsed = DATA.anrEvents[id];
    const card = document.createElement("div"), title = document.createElement("div"), reason = document.createElement("div"), details = document.createElement("details"), summary = document.createElement("summary"), pre = document.createElement("pre");
    card.className = "anr-detail-card"; title.className = "topline"; reason.className = "muted";
    title.textContent = `${event.date} · ${id} · ${event.version === "verified" ? event.appVersion + " 已核实" : "版本待核验"} · 内存 ${event.ramMb == null ? "未知" : event.ramMb + " MB"} · Android ${event.osVersion === "unknown" ? "未知" : event.osVersion}`;
    reason.textContent = parsed.reason;
    summary.textContent = "展开完整 longMsg（对应名称标红）";
    details.append(summary, pre);
    details.addEventListener("toggle", () => {
      if (details.open && !pre.dataset.loaded) {
        appendMarked(pre, event.longmsg, anrNeedle(parsed, selectedAnr.chartId));
        pre.dataset.loaded = "1";
      }
    });
    card.append(title, reason, details);
    fragment.append(card);
  }
  $("anrDetailList").append(fragment);
  anrOffset += slice.length;
  $("anrMore").hidden = anrOffset >= anrRows.length;
}
function render() {
  const ids = population(), base = qualifying(ids);
  const { primaryByCategory, byCategory } = summarizeCategories(base);
  renderPie(base, primaryByCategory);
  renderCategoryBars(base, byCategory, ids.length);
  renderAnrCharts(ids);
  const category = $("tag").value, query = $("search").value.toLowerCase().trim(), metric = $("metric").value;
  const filtered = base.filter(row => (category === "all" || row.categories.includes(category))
    && (row.name + " " + row.parent).toLowerCase().includes(query));
  const entities = new Map();
  for (const row of filtered) {
    const key = entityKey(row);
    if (!entities.has(key)) entities.set(key, {key, kind: row.kind, parent: row.parent, name: row.name, category: row.category, categories: new Set(), samples: 0, ids: new Set(), max: 0});
    const item = entities.get(key);
    row.categories.forEach(label => item.categories.add(label));
    item.samples++;
    item.ids.add(row.eventId);
    item.max = Math.max(item.max, row.cpu);
  }
  let list = [...entities.values()].map(item => ({...item, events: item.ids.size, value: metric === "samples" ? item.samples : item.ids.size}))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const allNames = list.length, limit = $("limit").value;
  if (limit !== "all") list = list.slice(0, Number(limit));
  const max = Math.max(1, ...list.map(item => item.value));
  $("chartMeta").textContent = `显示 ${list.length} / ${allNames} 个名称；${filtered.length} 条 CPU 采样；${new Set(filtered.map(row => row.eventId)).size} 条 ANR；所选范围 ${ids.length} 条 longMsg`;
  $("chart").replaceChildren();
  $("chart").scrollTop = 0;
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "当前筛选条件下没有 CPU 高于阈值的名称";
    $("chart").append(empty);
  }
  const fragment = document.createDocumentFragment();
  for (const item of list) {
    const row = document.createElement("div"), button = document.createElement("button"), track = document.createElement("div"), bar = document.createElement("div"), count = document.createElement("div"), minor = document.createElement("small");
    row.className = "barrow"; button.className = "entity"; track.className = "track"; bar.className = "bar"; count.className = "counts";
    button.append(...[...item.categories].map(badge), document.createTextNode((item.kind === "thread" ? item.parent + " / " : "") + item.name));
    button.title = "查看原始事件列表";
    button.onclick = () => selectEntity(item);
    bar.style.background = categoryInfo(item.category).color;
    bar.style.width = Math.max(0.5, item.value * 100 / max) + "%";
    track.append(bar);
    count.textContent = item.value;
    minor.textContent = (metric === "samples" ? item.events + " ANR" : item.samples + " 次采样") + " · 最高 " + item.max + "%";
    count.append(minor);
    row.append(button, track, count);
    fragment.append(row);
  }
  $("chart").append(fragment);
  $("stats").replaceChildren();
  for (const [number, label] of [[ids.length, "所选 longMsg"], [base.length, "超过阈值的采样行"], [new Set(base.map(row => row.eventId)).size, "命中事件"], [allNames, "匹配名称"]]) {
    const box = document.createElement("div"), strong = document.createElement("strong");
    box.className = "stat"; strong.textContent = number.toLocaleString();
    box.append(strong, document.createTextNode(label));
    $("stats").append(box);
  }
  if (selected) {
    detailRows = base.filter(row => entityKey(row) === selected.key);
    renderDetails(true);
  }
}
function selectEntity(item) {
  selected = item;
  detailRows = qualifying(population()).filter(row => entityKey(row) === item.key);
  renderDetails(true);
  $("details").scrollIntoView({behavior: "smooth", block: "start"});
  $("clear").hidden = false;
}
function renderDetails(reset) {
  if (reset) { $("detailList").replaceChildren(); $("detailList").scrollTop = 0; detailOffset = 0; }
  if (!selected) {
    $("detailMeta").textContent = "点击上方名称查看对应的 CPU 行与完整 longMsg。";
    $("more").hidden = true;
    return;
  }
  const count = new Set(detailRows.map(row => row.eventId)).size;
  $("detailMeta").replaceChildren();
  $("detailMeta").append(...[...selected.categories].map(badge), document.createTextNode(`${selected.kind === "thread" ? selected.parent + " / " : ""}${selected.name}：${detailRows.length} 次采样，${count} 条 ANR；CPU > ${threshold()}%`));
  const slice = detailRows.slice(detailOffset, detailOffset + 20), fragment = document.createDocumentFragment();
  for (const row of slice) {
    const card = document.createElement("div"), top = document.createElement("div"), meta = document.createElement("div"), raw = document.createElement("div"), details = document.createElement("details"), summary = document.createElement("summary"), pre = document.createElement("pre");
    const event = DATA.events[row.eventId];
    card.className = "detailitem"; top.className = "topline"; meta.className = "muted"; raw.className = "rawline";
    top.append(...row.categories.map(badge), document.createTextNode(`${row.eventTime} · ${row.eventId} · ${row.cpu}% · ${row.version === "verified" ? event.appVersion + " 已核实" : "版本待核验"} · 内存 ${event.ramMb == null ? "未知" : event.ramMb + " MB"} · Android ${event.osVersion === "unknown" ? "未知" : event.osVersion}`));
    meta.textContent = `原标签：${row.tagName} · CPU 段 ${row.block + 1} · ${row.relation} · ${row.blockHeader}`;
    appendMarked(raw, row.raw, selected.name);
    summary.textContent = "展开上报的 longMsg 原文（对应名称标红）";
    details.append(summary, pre);
    details.addEventListener("toggle", () => {
      if (details.open && !pre.dataset.loaded) {
        appendMarked(pre, event.longmsg, selected.name);
        pre.dataset.loaded = "1";
      }
    });
    card.append(top, meta, raw, details);
    fragment.append(card);
  }
  $("detailList").append(fragment);
  detailOffset += slice.length;
  $("more").hidden = detailOffset >= detailRows.length;
}

for (const [key, info] of Object.entries(CATEGORY)) {
  const option = document.createElement("option");
  option.value = key;
  option.textContent = info.name;
  $("tag").append(option);
}
const osVersions = [...new Set(Object.values(DATA.events).map(event => event.osVersion))]
  .sort((a, b) => a === "unknown" ? 1 : b === "unknown" ? -1 : Number(a) - Number(b));
for (const value of osVersions) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = value === "unknown" ? "未知" : "Android " + value;
  $("os").append(option);
}
for (const id of ["version", "ram", "os", "kind", "scope", "metric", "limit"]) $(id).addEventListener("change", render);
$("tag").addEventListener("change", () => {
  const expanded = $("tag").value !== "all";
  $("entitySection").open = expanded;
  selected = null;
  $("clear").hidden = true;
  $("detailList").replaceChildren();
  renderDetails(true);
  render();
  if (expanded) $("entitySection").scrollIntoView({behavior: "smooth", block: "start"});
});
$("search").addEventListener("input", render);
$("thresholdRange").addEventListener("input", () => { $("thresholdNumber").value = $("thresholdRange").value; render(); });
$("thresholdNumber").addEventListener("input", () => { $("thresholdRange").value = threshold(); render(); });
$("more").onclick = () => renderDetails(false);
$("detailList").addEventListener("scroll", () => {
  const list = $("detailList");
  if (selected && detailOffset < detailRows.length && list.scrollTop + list.clientHeight >= list.scrollHeight - 80) {
    renderDetails(false);
  }
});
$("clear").onclick = () => { selected = null; $("clear").hidden = true; $("detailList").replaceChildren(); renderDetails(true); };
$("anrMore").onclick = () => renderAnrDetails(false);
$("anrClear").onclick = () => { selectedAnr = null; anrRows = []; $("anrClear").hidden = true; renderAnrDetails(true); renderAnrCharts(population()); };
render();
