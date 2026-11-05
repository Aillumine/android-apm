/* Daily server snapshot: browsers use it only for the exact default date range. */
(function (global) {
  "use strict";

  const sections = {
    stability: ["crash_overview", "crash_daily", "crash_breakdown", "crash_by_version", "crash_by_model"],
    anr: ["anr_payload", "anr_details"],
    frame: ["frame_overview", "frame_percentiles", "frame_by_screen", "frame_daily_by_version", "frame_by_version"],
    startup: ["startup_overview", "startup_daily", "startup_by_version", "startup_by_model", "startup_by_os"],
    messages: ["msg_overview", "msg_daily", "msg_failure_breakdown", "msg_error_code", "msg_by_model", "msg_by_network", "msg_error_breakdown", "msg_timeout", "msg_vpn_split"],
    socket: ["ws_overview", "ws_daily", "ws_duration", "ws_reason", "ws_vpn_split"],
    payment: ["pay_funnel", "pay_step", "pay_failure", "pay_daily"],
    perf: ["perf_availability", "perf_percentiles"],
    dau: ["dau_version_daily", "dau_version_share"],
    device: ["device_summary", "device_brand_share", "device_model_share", "device_os_share"],
    tracking: ["tracking_business_daily"],
  };

  let snapshot = null;

  function matching(params) {
    if (!snapshot || snapshot.schema_version !== 1) return false;
    if (snapshot.date_start !== params.date_start || snapshot.date_end !== params.date_end || Number(params.use_date_end) !== 1) return false;
    if (params.jank_threshold != null && Number(params.jank_threshold) !== Number(snapshot.jank_threshold)) return false;
    if (params.cold_threshold_ms != null && Number(params.cold_threshold_ms) !== Number(snapshot.cold_threshold_ms)) return false;
    return true;
  }

  function lookup(names, params) {
    if (!matching(params) || !names.every(name => snapshot.datasets[name]?.rows)) return null;
    return Object.fromEntries(names.map(name => [name, snapshot.datasets[name]]));
  }

  function covers(section, params) {
    const names = sections[section];
    return Boolean(names && lookup(names, params));
  }

  async function load() {
    try {
      const response = await fetch("prefetch/latest.json.gz", { credentials: "include", cache: "no-store" });
      if (!response.ok) return false;
      const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
      const value = await new Response(stream).json();
      if (value?.schema_version !== 1 || typeof value.datasets !== "object" || !value.generated_at) return false;
      snapshot = value;
      return true;
    } catch (_) {
      return false;
    }
  }

  global.ApmPrefetch = { load, lookup, covers, sections };
})(typeof window !== "undefined" ? window : globalThis);
