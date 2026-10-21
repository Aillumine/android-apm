const SLUG = "android-apm";

const SECTION_META = {
  stability: { title: "稳定性", desc: "前台崩溃与 ANR 分离口径、按版本与机型下钻" },
  frame: { title: "流畅度", desc: "app_frame_performance 卡顿率分布、最卡页面与版本对比（1% 采样）" },
  startup: { title: "冷启动", desc: "process→onCreate、onCreate 方法体、到上报点的总耗时" },
  messages: { title: "收发消息", desc: "回复完成率、首字与总耗时分位、失败原因与网络类型（1% 采样）" },
  socket: { title: "WS 连接", desc: "连接成功率、失败与断开原因、连接耗时与会话时长（APP-15643 发版放量后生效）" },
  payment: { title: "支付漏斗", desc: "purchase_intent → checkout → 订单确认的分步转化、取消率与各步耗时（APP-15643 发版放量后生效）" },
  perf: { title: "FPS / 内存", desc: "app_performance（APP-15329 发版放量后生效）" },
  dau: { title: "日活版本占比", desc: "各 app_version 的 DAU 趋势与占比" },
  device: { title: "设备分布", desc: "品牌、机型与 Android 版本分布（Clickstream SDK 自动采集）" },
  tracking: { title: "商业化埋点", desc: "DAU、收入构成、ARPU 与 eCPM" },
};

const VERSION_PALETTE = [
  "#2563eb", "#059669", "#7c3aed", "#ea580c", "#0891b2",
  "#db2777", "#65a30d", "#d97706", "#475569", "#9333ea",
];

const state = {
  loadedSections: {},
  jankThreshold: 10,
  coldThreshold: 2000,
  dateRangeMode: "quick",
  charts: {},
};

function $(id) {
  return document.getElementById(id);
}

function dateParams() {
  const params = {
    date_start: $("startDate").value,
    use_date_end: state.dateRangeMode === "custom" ? 1 : 0,
  };
  if (state.dateRangeMode === "custom") params.date_end = $("endDate").value;
  return params;
}

// ---------- query plumbing (shared with the iOS dashboard) ----------

async function queryDatasetsDirect(names, params) {
  const resp = await fetch(`/api/views/${SLUG}/query`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...params, datasets: names }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(typeof err.detail === "string" ? err.detail : `HTTP ${resp.status}`);
  }
  const json = await resp.json();
  const resolved = window.DatasageAsyncQuery
    ? await window.DatasageAsyncQuery.resolveQueryResponse(json)
    : (json.datasets || {});
  return Object.fromEntries(names.map((name) => {
    const data = resolved[name];
    if (!data) throw new Error(`dataset "${name}" 无返回`);
    if (data.error || data.error_message) throw new Error(data.error_message || data.error);
    return [name, data];
  }));
}

async function exportDatasetResult(name, params) {
  const deadline = Date.now() + 15 * 60 * 1000;
  let submitResp;
  while (Date.now() < deadline) {
    submitResp = await fetch(`/api/views/${SLUG}/export`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...params, dataset: name, format: "parquet", max_rows: 20000 }),
    });
    if (submitResp.ok) break;
    const error = await submitResp.json().catch(() => ({}));
    const detail = typeof error.detail === "string" ? error.detail : "";
    if (!detail.includes("已有进行中的导出任务") && !detail.includes("同时最多 1 个导出任务")) {
      throw new Error(detail || `提交后台查询失败: HTTP ${submitResp.status}`);
    }
    setStatus("后台查询排队中，完成后将自动展示…");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (!submitResp?.ok) throw new Error("后台查询排队超时");

  let job = await submitResp.json();
  const jobId = job.id || job.job_id;
  if (job.status === "completed" && Array.isArray(job.data || job.rows)) {
    const data = job.rows || job.data;
    const columns = job.columns || Object.keys(data[0] || {});
    return {
      columns,
      rows: data.length && Array.isArray(data[0])
        ? data.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])))
        : data,
    };
  }
  if (!jobId) throw new Error("后台查询未返回 job_id");
  while (job.status !== "completed" && Date.now() < deadline) {
    if (job.status === "failed" || job.status === "expired") {
      throw new Error(job.error_message || `后台查询${job.status}`);
    }
    setStatus(`后台查询中，完成后将自动展示（${job.progress || 0}%）…`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const pollResp = await fetch(`/api/views/${SLUG}/export/${jobId}`, { credentials: "include" });
    if (!pollResp.ok) throw new Error(`查询后台任务失败: HTTP ${pollResp.status}`);
    job = await pollResp.json();
  }
  if (job.status !== "completed") throw new Error("后台查询超时");
  if (!job.download_url) throw new Error("后台查询完成但没有下载地址");
  const [{ parquetReadObjects }, { compressors }] = await Promise.all([
    import("https://esm.sh/hyparquet"),
    import("https://esm.sh/hyparquet-compressors"),
  ]);
  const resultResp = await fetch(new URL(job.download_url, location.origin), { credentials: "include" });
  if (!resultResp.ok) throw new Error(`读取后台结果失败: HTTP ${resultResp.status}`);
  const rows = await parquetReadObjects({ file: await resultResp.arrayBuffer(), compressors });
  return { columns: Object.keys(rows[0] || {}), rows };
}

let exportQueue = Promise.resolve();

function enqueueExportDataset(name, params) {
  const result = exportQueue.then(() => exportDatasetResult(name, params));
  exportQueue = result.catch(() => {});
  return result;
}

function isAsyncDegradation(error) {
  return [
    "Dashboard query degraded to async",
    "Hatchet run 已成功但本地无可靠结果",
    "查询轮询超时",
  ].some((message) => error.message.includes(message));
}

async function queryDatasets(names, extra = {}) {
  const params = { ...dateParams(), ...extra };
  try {
    return await queryDatasetsDirect(names, params);
  } catch (error) {
    if (!isAsyncDegradation(error)) throw error;
    const entries = [];
    for (const name of names) entries.push([name, await enqueueExportDataset(name, params)]);
    return Object.fromEntries(entries);
  }
}

// ---------- formatting ----------

function fmt(v, d = 1) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return Number(v).toFixed(d);
}

function fmtPct(r, d = 2) {
  if (r == null) return "—";
  return `${(Number(r) * 100).toFixed(d)}%`;
}

function fmtInt(v) {
  if (v == null) return "—";
  return Number(v).toLocaleString();
}

function fmtCompact(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtMs(v) {
  if (v == null) return "—";
  const n = Number(v);
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`;
}

function fmtUsd(v, d = 0) {
  if (v == null) return "—";
  return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: d })}`;
}

function escapeHtml(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(msg, kind = "info") {
  const el = $("globalStatus");
  if (!msg) {
    el.className = "status-bar hidden";
    return;
  }
  el.textContent = msg;
  el.className = `status-bar is-${kind}`;
}

// 复用已有实例（而不是 dispose 重建），这样重新查询时 ECharts 能做数据过渡动画；
// 返回一个轻代理，让调用方仍写 initChart(...).setOption(opt)。
function initChart(id, key) {
  const dom = $(id);
  if (!dom) return { setOption() {} };
  const inst = echarts.getInstanceByDom(dom) || echarts.init(dom);
  state.charts[key] = inst;
  return {
    setOption(opt) {
      inst.hideLoading();
      inst.setOption({ animationDuration: 550, animationEasing: "cubicOut", ...opt }, true);
      return inst;
    },
  };
}

// 骨架屏：按 section 容器统一处理，不用维护 id 清单。
function showSectionSkeleton(name) {
  const root = $(`sec-${name}`);
  if (!root) return;
  root.querySelectorAll(".hero-value").forEach((el) => {
    el.innerHTML = '<span class="skeleton skeleton-value"></span>';
  });
  root.querySelectorAll(".hero-meta").forEach((el) => {
    if (el.id) el.innerHTML = '<span class="skeleton skeleton-meta"></span>';
  });
  root.querySelectorAll("p.placeholder").forEach((el) => {
    el.innerHTML = '<span class="skeleton skeleton-text"></span><span class="skeleton skeleton-text short"></span>';
  });
  root.querySelectorAll(".grid-table").forEach((table) => {
    const body = table.querySelector("tbody");
    if (!body) return;
    const cols = table.querySelectorAll("thead th").length || 6;
    const cells = Array.from({ length: cols }, () => '<td><span class="skeleton skeleton-cell"></span></td>').join("");
    body.innerHTML = Array.from({ length: 5 }, () => `<tr>${cells}</tr>`).join("");
  });
  root.querySelectorAll(".panel").forEach((p) => p.classList.add("is-loading"));
}

function clearSectionSkeleton(name, { failed = false } = {}) {
  const root = $(`sec-${name}`);
  if (!root) return;
  root.querySelectorAll(".panel").forEach((p) => p.classList.remove("is-loading"));
  if (!failed) return;
  // 查询失败时骨架不能一直转，留下明确的空态。
  root.querySelectorAll(".hero-value").forEach((el) => {
    if (el.querySelector(".skeleton")) el.textContent = "—";
  });
  root.querySelectorAll(".hero-meta, p.placeholder").forEach((el) => {
    if (el.querySelector(".skeleton")) el.textContent = "查询失败";
  });
  root.querySelectorAll(".grid-table tbody").forEach((body) => {
    if (body.querySelector(".skeleton")) {
      body.innerHTML = '<tr><td colspan="12" class="placeholder">查询失败</td></tr>';
    }
  });
}

// 侧栏指示灯：ok / loading / error 三态，颜色即状态。
function setDataStatus(kind, text) {
  const dot = $("statusDot");
  const foot = $("statusFootText");
  if (dot) dot.className = `status-dot is-${kind}`;
  if (foot && text) foot.textContent = text;
}

const SECTION_CHARTS = {
  stability: ["stabilityTrendChart", "stabilityBreakdownChart", "stabilityCountChart"],
  frame: ["framepercentileChart", "frameVersionTrendChart", "frameScreenChart"],
  startup: ["startupPhaseChart", "startupTrendChart", "startupOsChart"],
  messages: [
    "msgTrendChart", "msgFailureChart", "msgErrorCodeChart", "msgLatencyChart",
    "msgModelChart", "msgNetworkChart", "msgTimeoutChart",
  ],
  perf: [],
  dau: ["dauTrendChart", "dauShareChart"],
  device: ["deviceBrandChart", "deviceOsChart", "deviceModelChart"],
  tracking: ["trackingRevenueChart", "trackingDauChart"],
};

const LOADING_OPTS = {
  text: "加载中…",
  color: "#2563eb",
  textColor: "#64748b",
  maskColor: "rgba(255, 255, 255, 0.7)",
  fontSize: 13,
};

function showSectionLoading(name) {
  (SECTION_CHARTS[name] || []).forEach((id) => {
    const dom = $(id);
    if (!dom) return;
    const inst = echarts.getInstanceByDom(dom) || echarts.init(dom);
    inst.showLoading("default", LOADING_OPTS);
  });
}

function clearSectionLoading(name) {
  (SECTION_CHARTS[name] || []).forEach((id) => {
    const dom = $(id);
    if (!dom) return;
    const inst = echarts.getInstanceByDom(dom);
    if (inst) inst.hideLoading();
  });
}

function resizeAll() {
  Object.values(state.charts).forEach((c) => c && c.resize());
}

// ---------- chart option builders ----------

const AXIS_X = {
  axisLabel: { color: "#64748b" },
  axisLine: { lineStyle: { color: "#e2e8f0" } },
  axisTick: { show: false },
};

const AXIS_Y = {
  axisLabel: { color: "#94a3b8" },
  splitLine: { lineStyle: { color: "#f1f5f9" } },
};

function barOption(labels, values, opts = {}) {
  const { colors, unit = "", decimals = 0, refLine = null, rotate = 0 } = opts;
  return {
    grid: { left: 52, right: 24, top: 36, bottom: rotate ? 96 : 32 },
    tooltip: { trigger: "axis", valueFormatter: (v) => `${Number(v).toFixed(decimals)}${unit}` },
    xAxis: { type: "category", data: labels, ...AXIS_X, axisLabel: { ...AXIS_X.axisLabel, rotate, fontSize: rotate ? 10 : 12 } },
    yAxis: { type: "value", min: 0, ...AXIS_Y },
    series: [{
      type: "bar",
      barWidth: "56%",
      data: values.map((v, i) => ({
        value: v,
        itemStyle: { borderRadius: [6, 6, 0, 0], color: Array.isArray(colors) ? colors[i] : (colors || "#2563eb") },
      })),
      label: {
        show: labels.length <= 12,
        position: "top",
        formatter: (p) => `${Number(p.value).toFixed(decimals)}`,
        color: "#334155", fontWeight: 700, fontSize: 12,
      },
      markLine: refLine ? {
        silent: true, symbol: "none",
        lineStyle: { type: "dashed", color: "#94a3b8", width: 1.5 },
        label: { formatter: refLine.label, position: "insideEndTop", color: "#64748b", fontSize: 11 },
        data: [{ yAxis: refLine.value }],
      } : undefined,
    }],
  };
}

function pieOption(labels, values, opts = {}) {
  const { formatter = (v) => fmtCompact(v) } = opts;
  return {
    tooltip: { trigger: "item", formatter: (p) => `${p.name}<br/>${formatter(p.value)} (${p.percent}%)` },
    legend: { type: "scroll", orient: "vertical", right: 8, top: "middle", textStyle: { color: "#64748b", fontSize: 11 } },
    series: [{
      type: "pie",
      radius: ["42%", "68%"],
      center: ["38%", "50%"],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 6, borderColor: "#fff", borderWidth: 2 },
      label: { show: false },
      data: labels.map((name, i) => ({ name, value: values[i], itemStyle: { color: VERSION_PALETTE[i % VERSION_PALETTE.length] } })),
    }],
  };
}

function multiLineOption(dates, series, opts = {}) {
  const { yAxes, decimals = 2, unit = "" } = opts;
  return {
    grid: { left: 56, right: 56, top: 48, bottom: 40 },
    tooltip: {
      trigger: "axis",
      valueFormatter: (v) => (v == null ? "—" : `${Number(v).toFixed(decimals)}${unit}`),
    },
    legend: { type: "scroll", top: 0, textStyle: { color: "#64748b", fontSize: 11 } },
    xAxis: { type: "category", data: dates, ...AXIS_X },
    yAxis: yAxes || [{ type: "value", ...AXIS_Y }],
    series: series.map((s, i) => ({
      name: s.name,
      type: "line",
      smooth: true,
      symbolSize: 6,
      connectNulls: false,
      yAxisIndex: s.yAxisIndex || 0,
      data: s.data,
      itemStyle: { color: s.color || VERSION_PALETTE[i % VERSION_PALETTE.length] },
      lineStyle: { width: 2.5, color: s.color || VERSION_PALETTE[i % VERSION_PALETTE.length] },
      areaStyle: s.area ? {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: `${s.color || VERSION_PALETTE[i % VERSION_PALETTE.length]}33` },
            { offset: 1, color: `${s.color || VERSION_PALETTE[i % VERSION_PALETTE.length]}05` },
          ],
        },
      } : undefined,
    })),
  };
}

function byVersionTrendOption(rows, valueKey, opts = {}) {
  const { decimals = 2, unit = "", sampleKey = "sampled_sessions", top = 8 } = opts;
  const dates = [...new Set(rows.map((r) => r.event_date))].sort();
  const totals = {};
  rows.forEach((r) => {
    totals[r.app_version] = (totals[r.app_version] || 0) + Number(r[sampleKey] || 0);
  });
  const versions = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, top).map(([v]) => v);
  return multiLineOption(
    dates,
    versions.map((v, i) => ({
      name: v,
      color: VERSION_PALETTE[i % VERSION_PALETTE.length],
      data: dates.map((dt) => {
        const hit = rows.find((r) => r.event_date === dt && r.app_version === v);
        return hit?.[valueKey] == null ? null : Number(hit[valueKey]);
      }),
    })),
    { decimals, unit },
  );
}

function fillTable(bodyId, rows, cells) {
  const body = $(bodyId);
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="12" class="placeholder">该区间无数据</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
}

// ---------- 稳定性 ----------

const IMPORTANCE_COLORS = {
  foreground: "#ef4444", visible: "#f97316", perceptible: "#f59e0b",
  "top-sleeping": "#a3a3a3", service: "#94a3b8", cached: "#cbd5e1", other: "#e2e8f0",
};

async function loadStability() {
  const overviewReq = queryDatasets(["crash_overview"]);
  const detailReq = queryDatasets(["crash_daily", "crash_breakdown", "crash_by_version", "crash_by_model"]);
  const o = (await overviewReq).crash_overview.rows[0] || {};

  $("heroCrashFree").textContent = fmtPct(o.crash_free_user_rate, 3);
  $("heroCrashFreeMeta").textContent =
    `${fmtInt(o.fg_crash_users)} 崩溃用户 / ${fmtInt(o.launch_users)} 启动用户 · 行业良好线 ≥ 99.5%`;
  $("heroAnrFree").textContent = fmtPct(o.anr_free_user_rate, 3);
  // Was "Google Play bad threshold ≥ 0.47%" as a direct benchmark. That threshold only counts
  // user-perceived ANRs (mostly input dispatch timeouts), while app_crash carries no ANR type and
  // this card counts every foreground ANR, so the two are not comparable (report feedback e6470d45).
  //
  // 原文案把 Google Play 0.47% 坏阈值当成直接对标线。该阈值只统计用户可感知 ANR（主要是 input dispatch
  // timeout），而 app_crash 没有上报 ANR 类型，本卡片统计的是全部前台 ANR，两者口径不同、不能直接对比
  // （报告意见 e6470d45）。
  $("heroAnrFreeMeta").textContent =
    `${fmtInt(o.fg_anr_users)} 前台 ANR 用户（全部类型）· 口径宽于 Google Play 用户可感知 ANR，不可直接对比其 0.47% 坏阈值`;
  $("heroCrashRate").textContent = fmtPct(o.crash_per_launch, 3);
  $("heroCrashRateMeta").textContent = `${fmtInt(o.fg_crash_count)} 次 / ${fmtInt(o.launches)} 次启动`;
  $("heroAnrRate").textContent = fmtPct(o.anr_per_launch, 3);
  $("heroAnrRateMeta").textContent = `${fmtInt(o.fg_anr_count)} 次 / ${fmtInt(o.launches)} 次启动`;

  $("stabilityNote").innerHTML =
    `区间内 <b>${fmtInt(o.all_exit_count)}</b> 条 app_crash 记录：` +
    `ANR <b>${fmtInt(o.anr_count)}</b>、JVM 崩溃 <b>${fmtInt(o.jvm_count)}</b>、Native 崩溃 <b>${fmtInt(o.native_count)}</b>；` +
    `其中 <b>${fmtInt(o.background_exit_count)}</b> 条发生在后台（CACHED / SERVICE 等），已从上方 Crash-free / ANR-free 指标中剔除。` +
    `崩溃在下次启动时补报，当日数字会随次日回填小幅上修。`;

  const data = await detailReq;
  const daily = data.crash_daily.rows;
  initChart("stabilityTrendChart", "stabilityTrend").setOption(multiLineOption(
    daily.map((r) => r.event_date),
    [
      { name: "Crash-free 用户率", color: "#2563eb", area: true, data: daily.map((r) => r.crash_free_user_rate == null ? null : Number(r.crash_free_user_rate) * 100) },
      { name: "ANR-free 用户率", color: "#ef4444", area: true, data: daily.map((r) => r.anr_free_user_rate == null ? null : Number(r.anr_free_user_rate) * 100) },
    ],
    { decimals: 3, unit: "%" },
  ));

  const bd = data.crash_breakdown.rows;
  const bdLabels = bd.slice(0, 12).map((r) => `${r.exit_reason} · ${r.importance_label}`);
  initChart("stabilityBreakdownChart", "stabilityBreakdown").setOption({
    ...barOption(bdLabels, bd.slice(0, 12).map((r) => Number(r.exit_count)), {
      colors: bd.slice(0, 12).map((r) => IMPORTANCE_COLORS[r.importance_label] || "#94a3b8"),
      rotate: 32,
    }),
    tooltip: { trigger: "axis", valueFormatter: (v) => fmtInt(v) },
  });

  initChart("stabilityCountChart", "stabilityCount").setOption(multiLineOption(
    daily.map((r) => r.event_date),
    [
      { name: "前台崩溃次数", color: "#2563eb", data: daily.map((r) => Number(r.fg_crash_count)) },
      { name: "前台 ANR 次数", color: "#ef4444", data: daily.map((r) => Number(r.fg_anr_count)) },
    ],
    { decimals: 0 },
  ));

  fillTable("stabilityVersionBody", data.crash_by_version.rows, (r) => [
    escapeHtml(r.app_version), fmtCompact(r.launches), fmtCompact(r.launch_users),
    fmtInt(r.fg_crash_count), fmtInt(r.fg_anr_count), fmtInt(r.anr_users),
    fmtPct(r.crash_free_user_rate, 3), fmtPct(r.anr_free_user_rate, 3),
    fmtPct(r.crash_per_launch, 3), fmtPct(r.anr_per_launch, 3),
  ]);

  fillTable("stabilityModelBody", data.crash_by_model.rows, (r) => [
    escapeHtml(r.brand), escapeHtml(r.model), escapeHtml(r.os_version),
    fmtCompact(r.launch_users), fmtInt(r.fg_crash_users), fmtInt(r.fg_anr_users),
    fmtPct(r.crash_user_ratio, 2), fmtPct(r.anr_user_ratio, 2),
  ]);
}

// ---------- 流畅度 ----------

async function loadFrame() {
  const params = { jank_threshold: state.jankThreshold };
  const overviewReq = queryDatasets(["frame_overview", "frame_percentiles"], params);
  const detailReq = queryDatasets(["frame_by_screen", "frame_daily_by_version", "frame_by_version"], params);
  const overview = await overviewReq;
  const o = overview.frame_overview.rows[0] || {};

  $("heroAvgJank").textContent = `${fmt(o.avg_jank_pct, 2)}%`;
  $("heroAvgJankMeta").textContent = `${fmtCompact(o.est_sessions)} 个观察窗口（采样 ${fmtCompact(o.sampled_sessions)}）`;
  $("heroP90Jank").textContent = `${fmt(o.p90_jank_pct, 2)}%`;
  $("heroP90JankMeta").textContent = `P95 ${fmt(o.p95_jank_pct, 2)}% · 平均超时 ${fmt(o.avg_overrun_ms, 2)}ms/帧`;
  $("heroBadSession").textContent = fmtPct(o.bad_session_ratio, 2);
  $("heroBadSessionMeta").textContent = `卡顿率 ≥ ${state.jankThreshold}% 的观察窗口占比`;
  $("heroMaxFrame").textContent = fmtMs(o.p95_max_frame_ms);
  $("heroMaxFrameMeta").textContent = `约 ${fmtCompact(o.est_total_frames)} 帧参与统计`;

  const p = overview.frame_percentiles.rows[0] || {};
  const keys = ["p50", "p75", "p90", "p95", "p98", "p99"];
  initChart("framepercentileChart", "framePercentile").setOption(barOption(
    keys.map((k) => k.toUpperCase()),
    keys.map((k) => Number(p[k])),
    {
      colors: ["#6366f1", "#6366f1", "#818cf8", "#818cf8", "#f59e0b", "#ef4444"],
      unit: "%", decimals: 2,
      refLine: { value: state.jankThreshold, label: `重度卡顿线 ${state.jankThreshold}%` },
    },
  ));

  const data = await detailReq;
  initChart("frameVersionTrendChart", "frameVersionTrend")
    .setOption(byVersionTrendOption(data.frame_daily_by_version.rows, "avg_jank_pct", { unit: "%", decimals: 2 }));

  const screens = data.frame_by_screen.rows;
  initChart("frameScreenChart", "frameScreen").setOption(barOption(
    screens.map((r) => r.screen),
    screens.map((r) => Number(r.avg_jank_pct)),
    { colors: screens.map((r) => (Number(r.avg_jank_pct) >= 3 ? "#ef4444" : Number(r.avg_jank_pct) >= 2 ? "#f59e0b" : "#2563eb")), unit: "%", decimals: 2, rotate: 38 },
  ));
  fillTable("frameScreenBody", screens, (r) => [
    escapeHtml(r.screen), fmtCompact(r.sampled_sessions), `${fmt(r.avg_jank_pct, 2)}%`,
    `${fmt(r.p90_jank_pct, 2)}%`, fmtMs(r.p95_max_frame_ms), fmtPct(r.bad_session_ratio, 2),
  ]);

  fillTable("frameVersionBody", data.frame_by_version.rows, (r) => [
    escapeHtml(r.app_version), fmtCompact(r.sampled_sessions), `${fmt(r.avg_jank_pct, 2)}%`,
    `${fmt(r.p90_jank_pct, 2)}%`, fmtMs(r.p95_max_frame_ms), fmtPct(r.bad_session_ratio, 2),
  ]);
}

// ---------- 冷启动 ----------

async function loadStartup() {
  const params = { cold_threshold_ms: state.coldThreshold };
  const overviewReq = queryDatasets(["startup_overview"], params);
  const detailReq = queryDatasets(["startup_daily", "startup_by_version", "startup_by_model", "startup_by_os"], params);
  const o = (await overviewReq).startup_overview.rows[0] || {};

  $("heroColdP50").textContent = fmtMs(o.p50_total_ms);
  $("heroColdP50Meta").textContent = `${fmtCompact(o.launches)} 次冷启动 · 覆盖率 ${fmtPct(o.total_coverage, 1)}`;
  $("heroColdP90").textContent = fmtMs(o.p90_total_ms);
  $("heroColdP90Meta").textContent = `P95 ${fmtMs(o.p95_total_ms)}`;
  $("heroSlowLaunch").textContent = fmtPct(o.slow_launch_ratio, 2);
  $("heroSlowLaunchMeta").textContent = `总耗时 ≥ ${state.coldThreshold}ms 的启动占比`;
  $("heroOnCreate").textContent = fmtMs(o.p90_oncreate_ms);
  $("heroOnCreateMeta").textContent = `P50 ${fmtMs(o.p50_oncreate_ms)} · process→onCreate P90 ${fmtMs(o.p90_process_to_create_ms)}`;

  const ffSamples = Number(o.first_frame_samples || 0);
  $("startupNote").innerHTML = ffSamples > 1000
    ? `首帧（TTID）样本 <b>${fmtInt(ffSamples)}</b> 条：P50 <b>${fmtMs(o.p50_first_frame_ms)}</b>，P90 <b>${fmtMs(o.p90_first_frame_ms)}</b>。`
    : `本区间 <code>startup_first_frame_ms</code> 仅 <b>${fmtInt(ffSamples)}</b> 条样本，不足以作为 TTID 指标——冷启动事件通常先于首帧绘制触发，该字段是 best-effort。真实 TTID 请以 Play Console / baselineprofile 基准为准，或等待埋点改为等待首帧后再上报。`;

  initChart("startupPhaseChart", "startupPhase").setOption({
    grid: { left: 64, right: 24, top: 44, bottom: 32 },
    tooltip: { trigger: "axis", valueFormatter: (v) => fmtMs(v) },
    legend: { top: 0, textStyle: { color: "#64748b" } },
    xAxis: { type: "category", data: ["process→onCreate", "onCreate 方法体", "到上报点总耗时"], ...AXIS_X },
    yAxis: { type: "value", min: 0, ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => `${v}ms` } },
    series: [
      {
        name: "P50", type: "bar", barWidth: "28%",
        data: [o.p50_process_to_create_ms, o.p50_oncreate_ms, o.p50_total_ms].map(Number),
        itemStyle: { color: "#2563eb", borderRadius: [6, 6, 0, 0] },
        label: { show: true, position: "top", formatter: (p) => fmtMs(p.value), color: "#334155", fontWeight: 700, fontSize: 11 },
      },
      {
        name: "P90", type: "bar", barWidth: "28%",
        data: [o.p90_process_to_create_ms, o.p90_oncreate_ms, o.p90_total_ms].map(Number),
        itemStyle: { color: "#ef4444", borderRadius: [6, 6, 0, 0] },
        label: { show: true, position: "top", formatter: (p) => fmtMs(p.value), color: "#334155", fontWeight: 700, fontSize: 11 },
      },
    ],
  });

  const data = await detailReq;
  const daily = data.startup_daily.rows;
  initChart("startupTrendChart", "startupTrend").setOption(multiLineOption(
    daily.map((r) => r.event_date),
    [
      { name: "P50 总耗时", color: "#2563eb", data: daily.map((r) => Number(r.p50_total_ms)) },
      { name: "P90 总耗时", color: "#ef4444", data: daily.map((r) => Number(r.p90_total_ms)) },
      { name: "P90 onCreate", color: "#f59e0b", data: daily.map((r) => Number(r.p90_oncreate_ms)) },
      { name: "覆盖率 %", color: "#94a3b8", yAxisIndex: 1, data: daily.map((r) => Number(r.coverage) * 100) },
    ],
    {
      decimals: 0,
      yAxes: [
        { type: "value", ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => `${v}ms` } },
        { type: "value", min: 80, max: 100, ...AXIS_Y, splitLine: { show: false }, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => `${v}%` } },
      ],
    },
  ));

  fillTable("startupVersionBody", data.startup_by_version.rows, (r) => [
    escapeHtml(r.app_version), fmtCompact(r.launches), fmtMs(r.p50_total_ms), fmtMs(r.p90_total_ms),
    fmtMs(r.p90_process_to_create_ms), fmtMs(r.p90_oncreate_ms), fmtPct(r.coverage, 1), fmtPct(r.slow_launch_ratio, 2),
  ]);

  const os = data.startup_by_os.rows;
  initChart("startupOsChart", "startupOs").setOption({
    ...barOption(os.map((r) => `Android ${r.os_version}`), os.map((r) => Number(r.p90_total_ms)), {
      colors: "#7c3aed", rotate: 0,
    }),
    tooltip: { trigger: "axis", valueFormatter: (v) => fmtMs(v) },
  });

  fillTable("startupModelBody", data.startup_by_model.rows, (r) => [
    escapeHtml(r.brand), escapeHtml(r.model), fmtCompact(r.launches),
    fmtMs(r.p50_total_ms), fmtMs(r.p90_total_ms), fmtPct(r.slow_launch_ratio, 2),
  ]);
}

// ---------- 收发消息 ----------

// 三类失败固定配色，四处图表共用，便于跨图对照。
const FAILURE_LABELS = {
  timeout: "本地超时",
  network: "网络失败",
  server: "服务端错误",
  protocol: "协议错误",
  unclassified: "未归类",
};

const FAILURE_COLORS = {
  timeout: "#ef4444",
  network: "#f59e0b",
  server: "#7c3aed",
  protocol: "#0891b2",
  unclassified: "#94a3b8",
};

async function loadMessages() {
  const overviewReq = queryDatasets(["msg_overview"]);
  const detailReq = queryDatasets([
    "msg_daily", "msg_failure_breakdown", "msg_error_code",
    "msg_by_model", "msg_by_network", "msg_error_breakdown", "msg_timeout",
    "msg_vpn_split",
  ]);
  const o = (await overviewReq).msg_overview.rows[0] || {};

  $("heroMsgCompleted").textContent = fmtPct(o.completed_rate, 3);
  $("heroMsgCompletedMeta").textContent =
    `约 ${fmtCompact(o.est_streams)} 次回复 · 失败 ${fmtCompact(o.est_failed)}`;
  $("heroMsgTimeout").textContent = fmtPct(o.timeout_ratio, 3);
  $("heroMsgTimeoutMeta").textContent = "客户端等待回复超时";
  $("heroMsgNetwork").textContent = fmtPct(o.network_ratio, 3);
  $("heroMsgNetworkMeta").textContent = "请求未能送达或链路中断";
  $("heroMsgServer").textContent = fmtPct(o.server_ratio, 3);
  $("heroMsgServerMeta").textContent = "服务端返回错误";

  // 闭合校验直接显示出来：这一行如果不等于 100%，说明有失败没有被归类。
  const closure =
    Number(o.completed_rate || 0) + Number(o.timeout_ratio || 0) +
    Number(o.network_ratio || 0) + Number(o.server_ratio || 0) +
    Number(o.other_failed_ratio || 0);
  const otherPct = Number(o.other_failed_ratio || 0);
  $("msgClosureLine").innerHTML =
    `成功率 + 三类失败占比${otherPct > 0 ? " + 其他" : ""} = <b>${(closure * 100).toFixed(4)}%</b>`;
  $("messagesNote").innerHTML =
    `四项归因同出一个 <code>chat_stream_result</code> 事件，分母是同一批请求，因此闭合到 ` +
    `<b>${(closure * 100).toFixed(4)}%</b>` +
    (otherPct > 0
      ? `，其中 <b>${fmtPct(otherPct, 4)}</b> 的失败没有 <code>interrupt_reason</code>，已单列为「其他」而不是被丢弃。`
      : `，且没有任何失败缺少 <code>interrupt_reason</code>。`) +
    ` 成功请求首字 P50 <b>${fmtMs(o.p50_first_content_ms)}</b> / P90 <b>${fmtMs(o.p90_first_content_ms)}</b>，` +
    `总耗时 P50 <b>${fmtMs(o.p50_total_ms)}</b> / P90 <b>${fmtMs(o.p90_total_ms)}</b>；` +
    `回复过程中切后台或离开聊天页占 <b>${fmtPct(o.exit_during_stream_ratio, 2)}</b>。`;

  const data = await detailReq;

  const daily = data.msg_daily.rows;
  initChart("msgTrendChart", "msgTrend").setOption(multiLineOption(
    daily.map((r) => r.event_date),
    [
      { name: "成功率", color: "#059669", area: true, data: daily.map((r) => Number(r.completed_rate) * 100) },
      { name: "本地超时", color: FAILURE_COLORS.timeout, yAxisIndex: 1, data: daily.map((r) => Number(r.timeout_ratio) * 100) },
      { name: "网络失败", color: FAILURE_COLORS.network, yAxisIndex: 1, data: daily.map((r) => Number(r.network_ratio) * 100) },
      { name: "服务端错误", color: FAILURE_COLORS.server, yAxisIndex: 1, data: daily.map((r) => Number(r.server_ratio) * 100) },
    ],
    {
      decimals: 3,
      unit: "%",
      yAxes: [
        { type: "value", min: 95, max: 100, ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => `${v}%` } },
        { type: "value", min: 0, ...AXIS_Y, splitLine: { show: false }, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => `${Number(v).toFixed(2)}%` } },
      ],
    },
  ));

  const failures = data.msg_failure_breakdown.rows;
  initChart("msgFailureChart", "msgFailure").setOption({
    grid: { left: 96, right: 60, top: 24, bottom: 32 },
    tooltip: { trigger: "axis", valueFormatter: (v) => `${Number(v).toFixed(2)}%` },
    xAxis: { type: "value", max: 100, ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => `${v}%` } },
    yAxis: {
      type: "category",
      data: failures.map((r) => FAILURE_LABELS[r.interrupt_reason] || r.interrupt_reason).reverse(),
      ...AXIS_X,
      axisLabel: { ...AXIS_X.axisLabel, fontWeight: 600 },
    },
    series: [{
      type: "bar",
      barWidth: "46%",
      data: failures.map((r) => ({
        value: Number(r.share_of_failures) * 100,
        itemStyle: { borderRadius: [0, 6, 6, 0], color: FAILURE_COLORS[r.interrupt_reason] || "#94a3b8" },
      })).reverse(),
      label: {
        show: true, position: "right",
        formatter: (p) => `${Number(p.value).toFixed(2)}%`,
        color: "#334155", fontWeight: 700, fontSize: 12,
      },
    }],
  });

  const codes = data.msg_error_code.rows;
  initChart("msgErrorCodeChart", "msgErrorCode").setOption({
    ...barOption(
      codes.map((r) => r.error_code),
      codes.map((r) => Number(r.share) * 100),
      {
        colors: codes.map((r) => FAILURE_COLORS[r.interrupt_reason] || "#94a3b8"),
        unit: "%", decimals: 2, rotate: codes.length > 10 ? 32 : 0,
      },
    ),
    tooltip: {
      trigger: "axis",
      formatter: (params) => {
        const i = params[0].dataIndex;
        const row = codes[i];
        return `error_code ${row.error_code}<br/>${FAILURE_LABELS[row.interrupt_reason] || row.interrupt_reason}` +
          `<br/>${fmtCompact(row.est_streams)} 次 · ${(Number(row.share) * 100).toFixed(2)}%`;
      },
    },
  });

  initChart("msgLatencyChart", "msgLatency").setOption({
    grid: { left: 64, right: 24, top: 44, bottom: 32 },
    tooltip: { trigger: "axis", valueFormatter: (v) => fmtMs(v) },
    legend: { top: 0, textStyle: { color: "#64748b" } },
    xAxis: { type: "category", data: ["首字耗时", "总耗时"], ...AXIS_X },
    yAxis: { type: "value", min: 0, ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => `${v}ms` } },
    series: [
      {
        name: "P50", type: "bar", barWidth: "26%",
        data: [Number(o.p50_first_content_ms), Number(o.p50_total_ms)],
        itemStyle: { color: "#2563eb", borderRadius: [6, 6, 0, 0] },
        label: { show: true, position: "top", formatter: (p) => fmtMs(p.value), color: "#334155", fontWeight: 700, fontSize: 12 },
      },
      {
        name: "P90", type: "bar", barWidth: "26%",
        data: [Number(o.p90_first_content_ms), Number(o.p90_total_ms)],
        itemStyle: { color: "#ef4444", borderRadius: [6, 6, 0, 0] },
        label: { show: true, position: "top", formatter: (p) => fmtMs(p.value), color: "#334155", fontWeight: 700, fontSize: 12 },
      },
    ],
  });

  const models = data.msg_by_model.rows;
  initChart("msgModelChart", "msgModel").setOption({
    grid: { left: 64, right: 24, top: 44, bottom: 88 },
    tooltip: {
      trigger: "axis",
      formatter: (params) => {
        const row = models[params[0].dataIndex];
        return `${row.model}<br/>约 ${fmtCompact(row.est_renders)} 次<br/>` +
          `首块 P50 ${fmtMs(row.p50_first_chunk_ms)}<br/>` +
          `首字 P50 ${fmtMs(row.p50_first_content_ms)} · P90 ${fmtMs(row.p90_first_content_ms)}<br/>` +
          `流式占比 ${fmtPct(row.streaming_share, 1)}`;
      },
    },
    legend: { top: 0, textStyle: { color: "#64748b" } },
    xAxis: {
      type: "category", data: models.map((r) => r.model), ...AXIS_X,
      axisLabel: { ...AXIS_X.axisLabel, rotate: 34, fontSize: 10 },
    },
    yAxis: { type: "value", min: 0, ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => `${v}ms` } },
    series: [
      { name: "首字 P50", type: "bar", barWidth: "32%", data: models.map((r) => Number(r.p50_first_content_ms)), itemStyle: { color: "#2563eb", borderRadius: [4, 4, 0, 0] } },
      { name: "首字 P90", type: "bar", barWidth: "32%", data: models.map((r) => Number(r.p90_first_content_ms)), itemStyle: { color: "#ef4444", borderRadius: [4, 4, 0, 0] } },
    ],
  });

  const net = data.msg_by_network.rows;
  initChart("msgNetworkChart", "msgNetwork").setOption({
    grid: { left: 64, right: 24, top: 44, bottom: 64 },
    tooltip: { trigger: "axis", valueFormatter: (v) => fmtMs(v) },
    legend: { top: 0, textStyle: { color: "#64748b" } },
    xAxis: {
      type: "category",
      data: net.map((r) => `${r.network_type}${r.is_streaming === "true" ? " · 流式" : " · 非流式"}`),
      ...AXIS_X,
      axisLabel: { ...AXIS_X.axisLabel, rotate: 24, fontSize: 10 },
    },
    yAxis: { type: "value", min: 0, ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => `${v}ms` } },
    series: [
      { name: "首块 P50", type: "bar", barWidth: "20%", data: net.map((r) => Number(r.p50_first_chunk_ms)), itemStyle: { color: "#93c5fd", borderRadius: [4, 4, 0, 0] } },
      { name: "首字 P50", type: "bar", barWidth: "20%", data: net.map((r) => Number(r.p50_first_content_ms)), itemStyle: { color: "#2563eb", borderRadius: [4, 4, 0, 0] } },
      { name: "首字 P90", type: "bar", barWidth: "20%", data: net.map((r) => Number(r.p90_first_content_ms)), itemStyle: { color: "#ef4444", borderRadius: [4, 4, 0, 0] } },
    ],
  });

  fillTable("msgVpnBody", data.msg_vpn_split.rows, (r) => [
    escapeHtml(r.vpn_state), fmtCompact(r.est_streams), fmtPct(r.share_of_streams),
    fmtPct(r.completed_rate, 3), fmtPct(r.timeout_ratio, 3), fmtPct(r.network_ratio, 3),
    fmtPct(r.server_ratio, 3), fmtMs(r.p50_first_content_ms), fmtMs(r.p90_first_content_ms),
    fmtMs(r.p90_total_ms),
  ]);

  fillTable("msgErrorBody", data.msg_error_breakdown.rows, (r) => [
    escapeHtml(r.failure_kind), escapeHtml(r.err_type), escapeHtml(r.error_code),
    escapeHtml(r.status_code), escapeHtml(r.ws_connected), fmtInt(r.error_count),
  ]);

  const to = data.msg_timeout.rows;
  const toDates = [...new Set(to.map((r) => r.event_date))].sort();
  const toKeys = [...new Set(to.map((r) => `${r.socket_connected}|${r.socket_type}`))];
  initChart("msgTimeoutChart", "msgTimeout").setOption(multiLineOption(
    toDates,
    toKeys.map((key) => {
      const [connected, type] = key.split("|");
      return {
        name: `socket_connected=${connected} · ${type}`,
        data: toDates.map((dt) => {
          const hit = to.find((r) => r.event_date === dt && r.socket_connected === connected && r.socket_type === type);
          return hit ? Number(hit.timeout_count) : 0;
        }),
      };
    }),
    { decimals: 0 },
  ));
}

// ---------- FPS / 内存 ----------

async function loadPerf() {
  const data = await queryDatasets(["perf_availability", "perf_percentiles"]);
  const a = data.perf_availability.rows[0] || {};
  const samples = Number(a.android_samples || 0);

  if (!samples) {
    $("perfAvailability").innerHTML =
      `本区间 Android <code>app_performance</code> 样本数为 <b>0</b>。` +
      `该埋点由 <b>APP-15329</b> 引入（commit <code>2ed77161d</code>，已在 main），` +
      `需要包含该提交的版本发布并放量后才会有数据。iOS 侧同名事件已在线，两端口径可对比但目前只有 iOS 有值。`;
    ["heroAvgFps", "heroMemP95", "heroJavaHeap", "heroNativeHeap"].forEach((id) => { $(id).textContent = "—"; });
    ["heroAvgFpsMeta", "heroMemP95Meta", "heroJavaHeapMeta", "heroNativeHeapMeta"].forEach((id) => { $(id).textContent = "等待发版"; });
    return;
  }

  $("perfAvailability").innerHTML =
    `Android <code>app_performance</code> 已有数据：<b>${fmtCompact(samples)}</b> 条，覆盖 ${a.first_date} ~ ${a.last_date}。`;
  const p = data.perf_percentiles.rows[0] || {};
  $("heroAvgFps").textContent = fmt(p.avg_fps, 1);
  $("heroAvgFpsMeta").textContent = `P90 ${fmt(p.fps_p90, 1)} · P95 ${fmt(p.fps_p95, 1)}（越低越差）`;
  $("heroMemP95").textContent = `${fmt(p.mem_p95, 0)} MB`;
  $("heroMemP95Meta").textContent = `P50 ${fmt(p.mem_p50, 0)} MB · P90 ${fmt(p.mem_p90, 0)} MB`;
  $("heroJavaHeap").textContent = `${fmt(p.java_heap_p90, 0)} MB`;
  $("heroJavaHeapMeta").textContent = "java_heap_used_mb P90";
  $("heroNativeHeap").textContent = `${fmt(p.native_heap_p90, 0)} MB`;
  $("heroNativeHeapMeta").textContent = "native_heap_used_mb P90";
}

// ---------- 日活版本占比 ----------

async function loadDau() {
  const data = await queryDatasets(["dau_version_daily", "dau_version_share"]);
  const daily = data.dau_version_daily.rows;
  const share = data.dau_version_share.rows;

  const dates = [...new Set(daily.map((r) => r.event_date))].sort();
  const top = share.slice(0, 8).map((r) => r.app_version);
  initChart("dauTrendChart", "dauTrend").setOption(multiLineOption(
    dates,
    top.map((v, i) => ({
      name: v,
      color: VERSION_PALETTE[i % VERSION_PALETTE.length],
      data: dates.map((dt) => {
        const hit = daily.find((r) => r.event_date === dt && r.app_version === v);
        return hit ? Number(hit.dau) : null;
      }),
    })),
    { decimals: 0 },
  ));

  initChart("dauShareChart", "dauShare")
    .setOption(pieOption(share.slice(0, 10).map((r) => r.app_version), share.slice(0, 10).map((r) => Number(r.dau))));

  const total = share.reduce((s, r) => s + Number(r.dau), 0);
  fillTable("dauBody", share.slice(0, 30), (r) => [
    escapeHtml(r.app_version), fmtCompact(r.dau), fmtPct(Number(r.dau) / total, 2),
  ]);
}

// ---------- 设备分布 ----------

async function loadDevice() {
  const data = await queryDatasets(["device_summary", "device_brand_share", "device_model_share", "device_os_share"]);
  const s = data.device_summary.rows[0] || {};
  $("heroDeviceUsers").textContent = fmtCompact(s.total_users);
  $("heroDeviceModels").textContent = fmtInt(s.distinct_models);
  $("heroDeviceBrands").textContent = fmtInt(s.distinct_brands);

  const brands = data.device_brand_share.rows;
  initChart("deviceBrandChart", "deviceBrand")
    .setOption(pieOption(brands.map((r) => r.brand), brands.map((r) => Number(r.users))));

  const os = data.device_os_share.rows;
  initChart("deviceOsChart", "deviceOs").setOption({
    ...barOption(os.map((r) => `Android ${r.os_version}`), os.map((r) => Number(r.users)), { colors: "#059669", rotate: 0 }),
    tooltip: { trigger: "axis", valueFormatter: (v) => fmtCompact(v) },
  });

  const models = data.device_model_share.rows;
  initChart("deviceModelChart", "deviceModel").setOption({
    ...barOption(models.map((r) => r.model), models.map((r) => Number(r.users)), { colors: "#2563eb", rotate: 42 }),
    tooltip: { trigger: "axis", valueFormatter: (v) => fmtCompact(v) },
  });

  const total = models.reduce((sum, r) => sum + Number(r.users), 0);
  fillTable("deviceBody", models, (r) => [
    escapeHtml(r.brand), escapeHtml(r.model), fmtCompact(r.users), fmtPct(Number(r.users) / total, 2),
  ]);
}

// ---------- 商业化埋点 ----------

async function loadTracking() {
  const data = await queryDatasets(["tracking_business_daily"]);
  let rows = data.tracking_business_daily.rows;
  if (!rows.length) {
    $("heroTrackDau").textContent = "—";
    fillTable("trackingBody", [], () => []);
    return;
  }
  // Before: the cards showed only the last row, so they never moved with the date range and, the
  // range always ending today, usually showed a day whose subscription/recharge revenue had not
  // settled yet. Now: the cards aggregate the whole range, and an unsettled trailing day is left
  // out of the cards and charts (it stays in the table, labelled).
  //
  // 改前：卡片只取最后一行，所以切换时间范围不会变；而区间总是到今天为止，最后一天的订阅和充值
  // 往往还没结算，数字明显偏低。改后：卡片按整个区间汇总，未结算的最后一天不计入卡片和趋势图
  // （日报明细里保留并标注）。
  const tail = rows[rows.length - 1];
  const unsettled = rows.length > 1
    && Number(tail.subscription_revenue) === 0 && Number(tail.recharge_revenue) === 0
    && rows.slice(0, -1).some((r) => Number(r.subscription_revenue) > 0 || Number(r.recharge_revenue) > 0);
  const allRows = rows;
  const settled = unsettled ? rows.slice(0, -1) : rows;
  const sum = (key) => settled.reduce((acc, r) => acc + Number(r[key] || 0), 0);
  const revenue = sum("total_revenue");
  const dauSum = sum("dau");
  const adRevenue = sum("ad_revenue");
  const impressions = sum("ad_impression_cnt");
  const rangeText = `${settled[0].event_date} ~ ${settled[settled.length - 1].event_date} · ${settled.length} 天`;

  $("heroTrackDau").textContent = fmtCompact(Math.round(dauSum / settled.length));
  $("heroTrackDauMeta").textContent = `日均 · ${rangeText}`;
  $("heroTrackRevenue").textContent = fmtUsd(revenue);
  $("heroTrackRevenueMeta").textContent = `广告 ${fmtUsd(adRevenue)} · 订阅 ${fmtUsd(sum("subscription_revenue"))} · 充值 ${fmtUsd(sum("recharge_revenue"))}`;
  $("heroTrackArpu").textContent = dauSum ? `$${(revenue / dauSum).toFixed(4)}` : "—";
  $("heroTrackArpuMeta").textContent = "区间总收入 / 区间 DAU 之和";
  $("heroTrackEcpm").textContent = impressions ? fmt((adRevenue / impressions) * 1000, 3) : "—";
  $("heroTrackEcpmMeta").textContent = `广告展示 ${fmtCompact(impressions)}`
    + (unsettled ? ` · 未计入 ${tail.event_date}（未结算）` : "");

  rows = settled;
  const dates = rows.map((r) => r.event_date);
  initChart("trackingRevenueChart", "trackingRevenue").setOption(multiLineOption(
    dates,
    [
      { name: "广告", color: "#2563eb", area: true, data: rows.map((r) => Number(r.ad_revenue)) },
      { name: "订阅", color: "#059669", area: true, data: rows.map((r) => Number(r.subscription_revenue)) },
      { name: "充值", color: "#7c3aed", area: true, data: rows.map((r) => Number(r.recharge_revenue)) },
      { name: "总收入", color: "#ef4444", data: rows.map((r) => Number(r.total_revenue)) },
    ],
    { decimals: 0 },
  ));

  initChart("trackingDauChart", "trackingDau").setOption(multiLineOption(
    dates,
    [
      { name: "DAU", color: "#2563eb", area: true, data: rows.map((r) => Number(r.dau)) },
      { name: "ARPU", color: "#ea580c", yAxisIndex: 1, data: rows.map((r) => Number(r.total_revenue) / Number(r.dau || 1)) },
    ],
    {
      decimals: 4,
      yAxes: [
        { type: "value", ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => fmtCompact(v) } },
        { type: "value", ...AXIS_Y, splitLine: { show: false }, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => `$${Number(v).toFixed(3)}` } },
      ],
    },
  ));

  fillTable("trackingBody", [...allRows].reverse(), (r) => [
    unsettled && r === tail ? `${r.event_date}（未结算）` : r.event_date, fmtCompact(r.dau), fmtUsd(r.total_revenue), fmtUsd(r.ad_revenue),
    fmtUsd(r.subscription_revenue), fmtUsd(r.recharge_revenue), fmt(r.iaa_ecpm, 3), fmtCompact(r.ad_impression_cnt),
  ]);
}

// ---------- WS 连接 ----------

// 埋点未发版时整段查询都是 0 行。空态必须说清「为什么空」，否则读者会当成查询挂了。
const PENDING_RELEASE = "(未发版)";

async function loadSocket() {
  const data = await queryDatasets(["ws_overview", "ws_daily", "ws_duration", "ws_reason", "ws_vpn_split"]);
  const o = data.ws_overview.rows[0] || {};
  const dur = data.ws_duration.rows[0] || {};
  const daily = data.ws_daily.rows;
  const reasons = data.ws_reason.rows;
  const hasData = Number(o.attempts || 0) > 0;

  if (!hasData) {
    ["heroWsRate", "heroWsStalled", "heroWsConnect", "heroWsSession"].forEach((id) => {
      $(id).textContent = PENDING_RELEASE;
    });
    ["heroWsRateMeta", "heroWsStalledMeta", "heroWsConnectMeta", "heroWsSessionMeta"].forEach((id) => {
      $(id).textContent = "—";
    });
    $("wsNote").textContent = "WS 连接指标依赖 APP-15643 新增的埋点，当前区间还没有数据 —— 需要等包含该版本的客户端发版放量。";
  } else {
    $("heroWsRate").textContent = fmtPct(o.connect_success_rate);
    $("heroWsRateMeta").textContent = `尝试 ${fmtCompact(o.attempts)} · 成功 ${fmtCompact(o.successes)} · 失败 ${fmtCompact(o.errors)}`;
    $("heroWsStalled").textContent = fmtPct(o.stalled_user_rate);
    $("heroWsStalledMeta").textContent = `${fmtCompact(o.stalled_users)} / ${fmtCompact(o.attempt_users)} 人连续失败超 30s`;
    $("heroWsConnect").textContent = fmtMs(dur.connect_p90);
    $("heroWsConnectMeta").textContent = `P50 ${fmtMs(dur.connect_p50)} · P99 ${fmtMs(dur.connect_p99)}`;
    $("heroWsSession").textContent = fmtMs(dur.session_p50);
    $("heroWsSessionMeta").textContent = `P90 ${fmtMs(dur.session_p90)} · 断开 ${fmtCompact(o.disconnects)} 次`;
    $("wsNote").textContent =
      `尝试 ${fmtCompact(o.attempts)} 次，成功 ${fmtPct(o.connect_success_rate)}；`
      + `${fmtCompact(o.stalled)} 次中断累计超过 30 秒（每次中断只报一次，不随时长成倍放大）。`;
  }

  const dates = daily.map((r) => r.event_date);
  initChart("wsTrendChart", "wsTrend").setOption(multiLineOption(
    dates,
    [
      { name: "连接成功率", color: "#059669", data: daily.map((r) => Number(r.connect_success_rate) * 100) },
      { name: "失败率", color: "#ef4444", yAxisIndex: 1, area: true, data: daily.map((r) => Number(r.error_rate) * 100) },
    ],
    {
      decimals: 2,
      unit: "%",
      yAxes: [
        { type: "value", ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => `${v}%` } },
        { type: "value", ...AXIS_Y, splitLine: { show: false }, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => `${v}%` } },
      ],
    },
  ));

  const errs = reasons.filter((r) => r.event_name === "ws_connect_error");
  const disc = reasons.filter((r) => r.event_name === "ws_disconnect");
  initChart("wsErrorChart", "wsError").setOption(pieOption(errs.map((r) => r.reason), errs.map((r) => Number(r.cnt))));
  initChart("wsDisconnectChart", "wsDisconnect").setOption(pieOption(disc.map((r) => r.reason), disc.map((r) => Number(r.cnt))));

  fillTable("wsVpnBody", data.ws_vpn_split.rows, (r) => [
    escapeHtml(r.vpn_state), fmtCompact(r.attempts), fmtCompact(r.successes), fmtCompact(r.errors),
    fmtPct(r.connect_success_rate), fmtPct(r.error_rate), fmtCompact(r.stalled),
  ]);

  initChart("wsDurationChart", "wsDuration").setOption(barOption(
    ["首连 P50", "重连 P50", "连接 P50", "连接 P90", "连接 P99", "中断时长 P50", "中断时长 P90"],
    [dur.first_connect_p50, dur.reconnect_p50, dur.connect_p50, dur.connect_p90, dur.connect_p99, dur.stalled_p50, dur.stalled_p90]
      .map((v) => Number(v || 0)),
    { colors: ["#2563eb", "#0891b2", "#059669", "#ea580c", "#ef4444", "#7c3aed", "#9333ea"], unit: " ms" },
  ));
}

// ---------- 支付漏斗 ----------

// 漏斗的顺序是产品链路顺序，不能按数量排序——按量排序会把「哪一步掉得最多」这个唯一要回答的
// 问题弄没了。
const PAY_FUNNEL_STEPS = [
  { key: "scene_enter", label: "进入付费页" },
  { key: "billing_product_fetch", label: "拉取 Play 商品" },
  { key: "purchase_intent", label: "发起购买" },
  { key: "checkout", label: "支付成功" },
  { key: "receipt_save", label: "回执上报" },
  { key: "transaction_finish", label: "订单确认" },
];

async function loadPayment() {
  const data = await queryDatasets(["pay_funnel", "pay_step", "pay_failure", "pay_daily"]);
  const f = data.pay_funnel.rows[0] || {};
  const steps = data.pay_step.rows;
  const daily = data.pay_daily.rows;
  const hasData = Number(f.flows || 0) > 0;

  const catalog = steps.find((r) => r.step === "catalog_load") || {};
  const catalogTotal = Number(catalog.success_cnt || 0) + Number(catalog.failed_cnt || 0);

  if (!hasData) {
    ["heroPayFinish", "heroPayCancel", "heroPayCatalog", "heroPayFlows"].forEach((id) => {
      $(id).textContent = PENDING_RELEASE;
    });
    ["heroPayFinishMeta", "heroPayCancelMeta", "heroPayCatalogMeta", "heroPayFlowsMeta"].forEach((id) => {
      $(id).textContent = "—";
    });
  } else {
    $("heroPayFinish").textContent = fmtPct(f.scene_to_finish_rate);
    $("heroPayFinishMeta").textContent = `进入 ${fmtCompact(f.scene_enter)} → 确认 ${fmtCompact(f.transaction_finish)}`;
    $("heroPayCancel").textContent = fmtPct(f.cancel_rate);
    $("heroPayCancelMeta").textContent = `${fmtCompact(f.cancelled)} 次用户取消（不计入失败）`;
    $("heroPayCatalog").textContent = catalogTotal ? fmtPct(Number(catalog.failed_cnt) / catalogTotal) : "—";
    $("heroPayCatalogMeta").textContent = `加载 ${fmtCompact(catalogTotal)} 次 · 失败 ${fmtCompact(catalog.failed_cnt)}`;
    $("heroPayFlows").textContent = fmtCompact(f.flows);
    $("heroPayFlowsMeta").textContent = "仅 flow_origin = foreground";
  }

  initChart("payFunnelChart", "payFunnel").setOption(barOption(
    PAY_FUNNEL_STEPS.map((s) => s.label),
    PAY_FUNNEL_STEPS.map((s) => Number(f[s.key] || 0)),
    { colors: ["#2563eb", "#0891b2", "#059669", "#65a30d", "#ea580c", "#7c3aed"], rotate: 20 },
  ));

  const dates = daily.map((r) => r.event_date);
  initChart("payTrendChart", "payTrend").setOption(multiLineOption(
    dates,
    [
      { name: "支付成功", color: "#059669", area: true, data: daily.map((r) => Number(r.checkout_ok)) },
      { name: "用户取消", color: "#ea580c", data: daily.map((r) => Number(r.checkout_cancelled)) },
      { name: "支付失败", color: "#ef4444", data: daily.map((r) => Number(r.checkout_failed)) },
      { name: "订单确认", color: "#2563eb", data: daily.map((r) => Number(r.finished)) },
    ],
    { decimals: 0 },
  ));

  const timed = steps.filter((r) => r.p90_ms !== null && r.p90_ms !== undefined);
  initChart("payDurationChart", "payDuration").setOption(barOption(
    timed.map((r) => r.step),
    timed.map((r) => Number(r.p90_ms || 0)),
    { colors: "#7c3aed", unit: " ms", rotate: 24 },
  ));

  initChart("payCatalogChart", "payCatalog").setOption(pieOption(
    ["成功", "失败", "账号切换后丢弃"],
    [Number(catalog.success_cnt || 0), Number(catalog.failed_cnt || 0), Number(catalog.skipped_cnt || 0)],
  ));

  fillTable("payFailureBody", data.pay_failure.rows, (r) => [
    escapeHtml(r.step), escapeHtml(r.status), escapeHtml(r.failure_reason),
    escapeHtml(r.billing_response_code), fmtCompact(r.cnt),
  ]);
}

// ---------- navigation & bootstrap ----------

const LOADERS = {
  stability: loadStability,
  frame: loadFrame,
  startup: loadStartup,
  messages: loadMessages,
  socket: loadSocket,
  payment: loadPayment,
  perf: loadPerf,
  dau: loadDau,
  device: loadDevice,
  tracking: loadTracking,
};

let currentSection = "stability";

async function runSection(name, { force = false } = {}) {
  if (state.loadedSections[name] && !force) return;
  showSectionLoading(name);
  showSectionSkeleton(name);
  setStatus("查询中…");
  setDataStatus("loading", "查询中…");
  const startedAt = Date.now();
  try {
    await LOADERS[name]();
    state.loadedSections[name] = true;
    setStatus("");
    clearSectionSkeleton(name);
    setDataStatus("ok", `ods_clickstream_app · Android · ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (error) {
    setStatus(`「${SECTION_META[name].title}」查询失败：${error.message}`, "error");
    clearSectionSkeleton(name, { failed: true });
    setDataStatus("error", `${SECTION_META[name].title} 查询失败`);
  } finally {
    clearSectionLoading(name);
  }
}

function switchSection(name) {
  currentSection = name;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.section === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `sec-${name}`));
  $("pageTitle").textContent = SECTION_META[name].title;
  $("pageDesc").textContent = SECTION_META[name].desc;
  runSection(name).then(resizeAll);
}

function setQuickRange(days) {
  state.dateRangeMode = "quick";
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  const iso = (d) => d.toISOString().slice(0, 10);
  $("startDate").value = iso(start);
  $("endDate").value = iso(end);
  state.dateRangeMode = "custom";
}

function invalidateAll() {
  state.loadedSections = {};
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => switchSection(btn.dataset.section));
});

document.querySelectorAll("#quickRange .quick-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#quickRange .quick-chip").forEach((c) => c.classList.toggle("active", c === chip));
    setQuickRange(Number(chip.dataset.days));
    invalidateAll();
    runSection(currentSection, { force: true });
  });
});

["startDate", "endDate"].forEach((id) => {
  $(id).addEventListener("change", () => {
    state.dateRangeMode = "custom";
    document.querySelectorAll("#quickRange .quick-chip").forEach((c) => c.classList.remove("active"));
  });
});

$("refreshBtn").addEventListener("click", () => {
  invalidateAll();
  runSection(currentSection, { force: true });
});

$("applyJank").addEventListener("click", () => {
  state.jankThreshold = Number($("jankThreshold").value) || 10;
  runSection("frame", { force: true });
});

$("applyCold").addEventListener("click", () => {
  state.coldThreshold = Number($("coldThreshold").value) || 2000;
  runSection("startup", { force: true });
});

// ---------- info tooltips（沿用 iOS 看板的 .tooltip-pop 样式与交互） ----------

const tooltipEl = document.createElement("div");
tooltipEl.className = "tooltip-pop";
document.body.appendChild(tooltipEl);

function positionTooltip(target) {
  const r = target.getBoundingClientRect();
  tooltipEl.style.left = "0px";
  tooltipEl.style.top = "0px";
  const tw = tooltipEl.offsetWidth;
  const th = tooltipEl.offsetHeight;
  const margin = 8;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin));
  let top = r.bottom + 8;
  if (top + th > window.innerHeight - margin) top = r.top - th - 8;
  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

function showTooltip(target) {
  const tip = target.getAttribute("data-tip");
  if (!tip) return;
  tooltipEl.innerHTML = tip;
  tooltipEl.classList.add("show");
  positionTooltip(target);
}

function hideTooltip() {
  tooltipEl.classList.remove("show");
}

document.addEventListener("mouseover", (e) => {
  const dot = e.target.closest(".info-dot");
  if (dot) showTooltip(dot);
});
document.addEventListener("mouseout", (e) => {
  const dot = e.target.closest(".info-dot");
  if (dot && !dot.contains(e.relatedTarget)) hideTooltip();
});
document.addEventListener("click", (e) => {
  const dot = e.target.closest(".info-dot");
  if (dot) {
    e.preventDefault();
    if (tooltipEl.classList.contains("show")) hideTooltip();
    else showTooltip(dot);
  } else {
    hideTooltip();
  }
});

window.addEventListener("resize", resizeAll);

setQuickRange(2);
switchSection("stability");
