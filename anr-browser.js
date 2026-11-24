/* Small metadata queries first; decode only the explicitly selected event. */
(() => {
  "use strict";
  const PAGE_SIZE = 100;
  const MAX_PARAMS_BYTES = 256 * 1024;
  const params = new URLSearchParams(location.search);
  const dateStart = params.get("date_start"), dateEnd = params.get("date_end");
  const root = document.getElementById("anrBrowser");
  const state = { snapshot: null, summary: null, page: [], pageIndex: 0, cursors: [{ timestamp: 0, id: "" }], nextCursor: null, hasMore: false, kind: "all", generation: 0, busy: false, bodyBusy: false, bodyRequest: 0 };
  const ui = {};

  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = String(text);
    if (className) el.className = className;
    return el;
  }
  function rowsOf(dataset) {
    if (!dataset || !Array.isArray(dataset.rows)) throw new Error("数据集没有返回完整行");
    if (!dataset.rows.length || !Array.isArray(dataset.rows[0])) return dataset.rows;
    if (!Array.isArray(dataset.columns)) throw new Error("数据集缺少列定义");
    return dataset.rows.map(row => Object.fromEntries(dataset.columns.map((key, index) => [key, row[index]])));
  }
  function number(value) { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString("zh-CN") : "—"; }
  function eventTime(value) {
    const time = Number(value);
    return Number.isFinite(time) && time > 0
      ? new Date(time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "时间缺失";
  }
  function count(key) { return Math.max(0, Number(state.summary?.[key]) || 0); }
  function total() { return count(state.kind === "canonical" ? "canonical_with_chunk0" : state.kind === "candidate" ? "candidate_with_chunk0" : "anr_total"); }
  function kindLabel(kind) { return kind === "canonical" ? "规则关联日志 · 待校验" : kind === "candidate" ? "同进程候选 · 未关联" : "未取得关联日志"; }
  let readinessSent = false;
  function reportReady() {
    if (readinessSent) return;
    readinessSent = true;
    if (window.parent !== window) window.parent.postMessage({ source: "android-apm-anr", requestId: params.get("request_id") || "", error: "", view: "events", phase: "ready", dateStart, dateEnd, message: "诊断摘要与分页事件" }, location.origin);
  }
  async function query(name, extra = {}) {
    if (window.parent === window || typeof window.parent.queryAnrDatasets !== "function") throw new Error("请从更新后的 Android APM 看板进入");
    const data = await window.parent.queryAnrDatasets([name], {
      date_start: dateStart, date_end: dateEnd, use_date_end: 1,
      ...(state.snapshot === null ? {} : { snapshot_etl: state.snapshot }), ...extra,
    });
    return rowsOf(data[name]);
  }
  function message(text, failed = false) {
    ui.status.textContent = text;
    ui.status.classList.toggle("failed", failed);
    ui.status.setAttribute("role", failed ? "alert" : "status");
  }
  function updateControls() {
    ui.kind.disabled = state.busy;
    ui.refresh.disabled = state.busy;
    ui.previous.disabled = state.busy || state.pageIndex === 0;
    ui.next.disabled = state.busy || !state.hasMore;
  }
  function shell() {
    const style = node("style");
    style.textContent = `#anrBrowser [hidden]{display:none!important}#anrBrowser .browser-table-wrap{overflow:auto;background:#fff;border:1px solid #dbe6ef;border-radius:12px}#anrBrowser table{width:100%;border-collapse:collapse;font-size:12px}#anrBrowser th,#anrBrowser td{padding:11px 12px;text-align:left;border-bottom:1px solid #e1e9ef;vertical-align:top}#anrBrowser th{background:#edf3f8;white-space:nowrap}#anrBrowser code{font:11px/1.5 ui-monospace,monospace;overflow-wrap:anywhere}#anrBrowser button,#anrBrowser .browser-link{font:inherit;border:1px solid #afc6d8;border-radius:7px;background:#fff;padding:8px 11px;color:#145b8b;cursor:pointer}#anrBrowser button:disabled{cursor:default;opacity:.5}#anrBrowser .browser-pages{display:flex;gap:12px;align-items:center;margin:16px 0;flex-wrap:wrap}#anrBrowser .failed{border-color:#b3261e;background:#fff0ef}#anrBrowser .candidate{border-left:4px solid #b66b00;background:#fff8e8}#anrBrowser .canonical{border-left:4px solid #006a6a;background:#edf9f8}#anrBrowser .event-body{padding:18px;background:#f8fbfd}#anrBrowser pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:65vh;overflow:auto;background:#edf3f8;padding:14px;font:12px/1.5 ui-monospace,monospace}#anrBrowser details{margin:10px 0}#anrBrowser summary{cursor:pointer;font-weight:650}#anrBrowser .body-note{padding:12px;border-radius:7px}#anrBrowser .stat small{display:block;max-width:240px;color:#61778b}#anrBrowser .browser-source{font-size:12px;color:#52697f;overflow-wrap:anywhere}`;
    document.head.append(style);
    const header = node("header");
    header.append(node("h1", "ANR 诊断概览"), node("p", "先查看数量和事件列表；展开一条时才读取其日志与主线程栈。同进程候选单独展示，不能认定是同一次卡顿。"));
    ui.status = node("div", "正在读取摘要…", "notice");
    ui.stats = node("div", undefined, "stats");
    ui.source = node("p", `${dateStart} 至 ${dateEnd} · Android / com.flow.mobile`, "browser-source");
    const controls = node("div", undefined, "controls"), label = node("label", "日志范围");
    ui.kind = node("select");
    for (const [value, text] of [["all", "全部 ANR"], ["canonical", "仅规则关联日志"], ["candidate", "仅同进程未关联候选"]]) {
      const option = node("option", text); option.value = value; ui.kind.append(option);
    }
    label.append(ui.kind);
    ui.kind.onchange = () => { state.kind = ui.kind.value; resetPages(); loadPage().catch(showPageError); };
    ui.refresh = node("button", "刷新摘要与列表"); ui.refresh.onclick = () => refresh({ bypassPrefetch: true });
    ui.cpu = node("a", "查看高 CPU 来源明细", "browser-link");
    const cpuParams = new URLSearchParams(location.search); cpuParams.set("view", "cpu"); cpuParams.delete("live");
    const cpuStart = params.get("cpu_date_start"), cpuEnd = params.get("cpu_date_end");
    if (/^\d{4}-\d{2}-\d{2}$/.test(cpuStart || "") && /^\d{4}-\d{2}-\d{2}$/.test(cpuEnd || "") &&
        (cpuStart !== dateStart || cpuEnd !== dateEnd)) {
      cpuParams.set("date_start", cpuStart);
      cpuParams.set("date_end", cpuEnd);
      ui.cpu.textContent = `高 CPU 来源明细（${cpuStart} 至 ${cpuEnd}）`;
    }
    ui.cpu.href = `anr-dashboard.html?${cpuParams}`;
    controls.append(label, ui.refresh, ui.cpu);
    const cpuOverview = node("div");
    const note = node("p", "数量按服务端事件去重统计，正文是否完整仍需逐条解码校验。候选日志不计入规则关联覆盖率；主线程栈与候选日志并列展示不代表二者严格匹配。");
    const wrapper = node("div", undefined, "browser-table-wrap"), table = node("table"), head = node("thead"), tr = node("tr");
    for (const name of ["客户端事件时间（北京时间） / 事件", "版本", "机型", "ANR 类型", "日志归属 / 状态", "分片数", "摘要", "详情"]) tr.append(node("th", name));
    head.append(tr); ui.rows = node("tbody"); table.append(head, ui.rows); wrapper.append(table);
    const pages = node("div", undefined, "browser-pages");
    ui.previous = node("button", "上一页"); ui.next = node("button", "下一页"); ui.pageInfo = node("span", `每页 ${PAGE_SIZE} 条`);
    ui.previous.onclick = () => { state.pageIndex = Math.max(0, state.pageIndex - 1); loadPage().catch(showPageError); };
    ui.next.onclick = () => { if (!state.nextCursor) return; state.cursors = state.cursors.slice(0, state.pageIndex + 1); state.cursors.push(state.nextCursor); state.pageIndex++; loadPage().catch(showPageError); };
    pages.append(ui.previous, ui.pageInfo, ui.next);
    root.append(header, ui.source, ui.status, ui.stats, controls, cpuOverview, note, wrapper, pages);
    updateControls();
    window.renderAnrCpuOverview(cpuOverview, cpuParams.get("date_start"), cpuParams.get("date_end")).catch(() => {});
  }
  function renderSummary() {
    ui.stats.replaceChildren();
    const canonical = count("canonical_with_chunk0"), candidate = count("candidate_with_chunk0"), n = count("anr_total");
    for (const [title, value, detail] of [
      ["ANR 事件", n, "同一事件只计一次"],
      ["规则关联日志条目", canonical, `有首片，待正文校验 · ${n ? (canonical * 100 / n).toFixed(2) : "0.00"}%`],
      ["同进程未关联候选", candidate, "仅供排查，不纳入关联覆盖率"],
      ["无上述日志条目", Math.max(0, n - canonical - candidate), "包含缺失、无诊断状态或正文缺首片"],
    ]) {
      const card = node("div", title, "stat"); card.append(node("strong", number(value)), node("small", detail)); ui.stats.append(card);
    }
    ui.source.textContent = `${dateStart} 至 ${dateEnd} · Android / com.flow.mobile · ETL 快照水位：${state.snapshot ?? "无"} · 本页不批量下载或解码正文`;
  }
  function resetPages() {
    state.pageIndex = 0; state.cursors = [{ timestamp: 0, id: "" }]; state.nextCursor = null; state.hasMore = false;
  }
  async function refresh({ bypassPrefetch = false } = {}) {
    if (dateStart < "2026-11-10") {
      message("legacy_range_unsupported：此摘要与分页仅支持 2026-11-10 起的数据。当前日期包含更早区间，不能将空结果视为完整历史；请调整起始日期，或打开同日期已发布的 CPU 归因预取。", true);
      ui.kind.disabled = true; ui.refresh.disabled = true; ui.previous.disabled = true; ui.next.disabled = true;
      reportReady();
      return;
    }
    if (state.busy) return;
    const generation = ++state.generation;
    state.busy = true; state.snapshot = null; state.summary = null; resetPages(); state.page = []; state.bodyRequest++;
    ui.stats.replaceChildren(); ui.source.textContent = `${dateStart} 至 ${dateEnd} · 正在建立新的查询快照`;
    ui.rows.replaceChildren(); updateControls(); message("正在读取去重摘要…");
    try {
      const rows = await query("anr_summary", bypassPrefetch ? { bypass_prefetch: true } : {});
      if (generation !== state.generation) return;
      if (rows.length !== 1) throw new Error("摘要必须恰好返回一行");
      const summary = rows[0];
      for (const key of ["anr_total", "canonical_with_chunk0", "candidate_with_chunk0"]) {
        if (summary[key] == null || !Number.isFinite(Number(summary[key])) || Number(summary[key]) < 0) throw new Error(`摘要计数无效：${key}`);
      }
      if (Number(summary.canonical_with_chunk0) + Number(summary.candidate_with_chunk0) > Number(summary.anr_total)) throw new Error("摘要分类计数超过总数");
      if (summary.snapshot_etl === undefined || summary.snapshot_etl === null || String(summary.snapshot_etl).trim() === "") {
        if (Number(summary.anr_total) !== 0) throw new Error("摘要缺少分页快照水位");
      }
      state.summary = summary; state.snapshot = summary.snapshot_etl ?? null;
      renderSummary();
      reportReady();
      state.busy = false;
      if (!Number(summary.anr_total)) { message("当前日期范围没有符合条件的 ANR；这不代表今日分区已完成。"); ui.pageInfo.textContent = "0 条"; return; }
      await loadPage();
    } catch (error) { message(`摘要或列表读取失败：${error.message}。可重试或缩小日期范围。`, true); }
    finally { state.busy = false; updateControls(); reportReady(); }
  }
  function showPageError(error) { message(`分页读取失败：${error.message}。不会回退为全量正文导出。`, true); }
  async function loadPage() {
    if (state.snapshot === null) throw new Error("请先取得有效摘要快照");
    const generation = ++state.generation;
    state.busy = true; state.bodyRequest++; state.page = []; state.hasMore = false; state.nextCursor = null; ui.rows.replaceChildren(); ui.pageInfo.textContent = "正在读取本页…"; updateControls(); message("正在读取本页元数据…");
    try {
      const cursor = state.cursors[state.pageIndex];
      if (!cursor) throw new Error("分页游标无效，请重新选择筛选条件");
      const rows = await query("anr_page", { record_kind: state.kind, cursor_event_timestamp: cursor.timestamp, cursor_event_id: cursor.id });
      if (generation !== state.generation) return;
      if (rows.length > PAGE_SIZE + 1) throw new Error("分页结果超过约定上限");
      const ids = new Set();
      for (const row of rows) {
        if (!row.event_id || !row.record_fingerprint || !validEventHour(row.event_hour)
            || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.event_date).slice(0, 10))) throw new Error("事件标识或小时分区缺失");
        if (ids.has(row.event_id)) throw new Error("本页出现重复事件，拒绝重复计数");
        ids.add(row.event_id);
      }
      state.hasMore = rows.length > PAGE_SIZE;
      state.page = rows.slice(0, PAGE_SIZE);
      const last = state.page.at(-1);
      state.nextCursor = state.hasMore && last ? { timestamp: last.event_timestamp, id: last.event_id } : null;
      renderPage();
      message("元数据已就绪。点击“读取正文”才会查询并解码这一条；空缺日志不会构造正文。");
    } finally { if (generation === state.generation) { state.busy = false; updateControls(); } }
  }
  function renderPage() {
    ui.rows.replaceChildren();
    for (const row of state.page) {
      const tr = node("tr"), time = node("td", eventTime(row.event_timestamp));
      time.append(node("br"), node("code", row.event_id));
      const classification = node("td", kindLabel(row.record_kind)); classification.append(node("br"), node("code", row.anr_status || "未上报诊断状态"));
      const probe = node("td");
      if (row.probe_json) {
        const details = node("details"); details.append(node("summary", "查询诊断摘要"), node("pre", pretty(row.probe_json))); probe.append(details);
      } else probe.append(node("span", "missing"));
      const action = node("td"), button = node("button", Number(row.chunk_count) > 0 ? "读取正文" : "无正文分片");
      button.disabled = !(Number(row.chunk_count) > 0);
      action.append(button);
      tr.append(time, node("td", row.app_version || "未知"), node("td", row.device_model || "未知"), node("td", row.anr_type || "未知"), classification, node("td", number(row.chunk_count)), probe, action);
      const detailTr = node("tr"), detailTd = node("td", undefined, "event-body"); detailTd.colSpan = 8; detailTr.hidden = true; detailTr.append(detailTd);
      let rendered = false;
      button.onclick = async () => {
        if (rendered) { detailTr.hidden = !detailTr.hidden; button.textContent = detailTr.hidden ? "展开正文" : "收起正文"; return; }
        if (state.bodyBusy) { message("正在读取另一条正文，请等待其完成后再展开。"); return; }
        const request = ++state.bodyRequest;
        state.bodyBusy = true; button.disabled = true; button.textContent = "读取中…"; detailTr.hidden = false; detailTd.textContent = "正在按事件 ID 与分区读取一条正文…";
        try {
          const rows = await query("anr_event_body", {
            event_id: row.event_id,
            event_date: String(row.event_date).slice(0, 10),
            event_hour: Number(row.event_hour),
          });
          const body = await decodeEvent(rows, row);
          if (request !== state.bodyRequest) return;
          renderBody(detailTd, row, body); rendered = true; button.textContent = "收起正文";
        } catch (error) { if (request === state.bodyRequest) { detailTd.textContent = `正文未通过校验：${error.message}`; button.textContent = "重试正文"; } }
        finally { state.bodyBusy = false; button.disabled = false; }
      };
      ui.rows.append(tr, detailTr);
    }
    if (!state.page.length) { const tr = node("tr"), td = node("td", "当前筛选没有事件。"); td.colSpan = 8; tr.append(td); ui.rows.append(tr); }
    ui.pageInfo.textContent = `${state.page.length ? state.pageIndex * PAGE_SIZE + 1 : 0}–${state.pageIndex * PAGE_SIZE + state.page.length} / ${number(total())} 条 · 每页 ${PAGE_SIZE} 条`;
  }
  function pretty(value) {
    try { return JSON.stringify(typeof value === "string" ? JSON.parse(value) : value, null, 2); }
    catch (_) { return String(value); }
  }
  const validEventHour = window.AnrAttribution.validEventHour;
  const decodeEvent = window.AnrAttribution.decodeEvent;
  function renderBody(container, row, body) {
    container.replaceChildren();
    const candidate = row.record_kind === "candidate", canonical = row.record_kind === "canonical";
    container.append(node("div", candidate ? "同进程候选日志：未通过本次退出的时间关联。下方主线程栈属于退出记录，不能与候选日志合并认定为同一次卡顿。" : canonical ? "规则关联日志：已通过客户端的进程与时间规则关联；规则关联不等于严格证明同一次卡顿。" : "该事件没有规则关联的 longMsg。下方仅展示实际上报的字段，missing 不代表系统从未生成过日志。", `body-note ${candidate ? "candidate" : canonical ? "canonical" : ""}`));
    container.append(node("p", `event_id: ${row.event_id} · association: ${body.association || "missing"}${body.unmatched_reason ? ` · candidate reason: ${body.unmatched_reason}` : ""}`));
    if (Array.isArray(body.truncated) && body.truncated.length) container.append(node("div", `客户端已标记截断：${body.truncated.join(", ")}。这里只展示实际收到的正文，不补全。`, "notice"));
    for (const [key, title] of [["longmsg", "规则关联 longMsg"], ["unmatched_longmsg", "同进程未关联候选 longMsg"], ["main_stack", "退出记录主线程栈"]]) {
      const detail = node("details"); detail.open = Boolean(body[key]);
      detail.append(node("summary", `${title}${body[key] ? "" : " · missing"}`), node("pre", body[key] || "missing：此字段未采集到或未关联成功。")); container.append(detail);
    }
    const decoded = node("details"); decoded.append(node("summary", "完整解码 JSON"), node("pre", JSON.stringify(body, null, 2))); container.append(decoded);
  }
  window.AnrEventBrowser = { rowsOf, decodeEvent, PAGE_SIZE, MAX_PARAMS_BYTES };
  async function start() {
    shell();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStart || "") || !/^\d{4}-\d{2}-\d{2}$/.test(dateEnd || "") || dateStart > dateEnd) {
      message("日期参数无效，请从主看板选择日期。", true); reportReady(); return;
    }
    await refresh();
  }
  start();
})();
