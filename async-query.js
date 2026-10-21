/**
 * async-query.js — shared helper for dashboards that call POST /api/views/{id}/query
 * without ViewsSDK / ViewApp.
 *
 * Spec v2026.08-dashboard-async-poll:
 *   When DASHBOARD_ASYNC_POLL_ENABLED=true, the API returns
 *   { mode:'async', job_id, poll_url } per dataset. This helper polls
 *   GET /api/v1/queries/{id} until terminal and normalizes to {columns, rows}.
 *
 * Usage:
 *   <script src="/api/v1/artifacts/content/_shared/async-query.js"></script>
 *   // or relative sdk sibling when served via content fallback
 *   const json = await fetch(.../query).then(r => r.json());
 *   const data = await DatasageAsyncQuery.resolveDataset(json.datasets.foo);
 */
(function (global) {
  'use strict';

  async function pollGatewayJob(jobInfo, opts) {
    opts = opts || {};
    const jobId = jobInfo.job_id;
    if (!jobId) throw new Error('async job missing job_id');
    const pollUrl = jobInfo.poll_url || `/api/v1/queries/${jobId}`;
    const timeoutMs = opts.timeoutMs || 120000;
    const start = Date.now();
    let delay = 500;
    while (Date.now() - start < timeoutMs) {
      const url = pollUrl.startsWith('http') ? pollUrl : pollUrl;
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error(`Job poll failed: HTTP ${r.status}`);
      const job = await r.json();
      const status = job.status;
      if (status === 'succeeded' || status === 'success') {
        const payload = (job.result && typeof job.result === 'object') ? job.result : job;
        const columns = job.columns || payload.columns || [];
        const data = job.data || payload.data || [];
        const rows = Array.isArray(data) && data.length && Array.isArray(data[0])
          ? data.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])))
          : (Array.isArray(data) ? data : []);
        const out = {
          columns: columns,
          rows: rows,
          row_count: job.row_count != null ? job.row_count : (payload.row_count != null ? payload.row_count : rows.length),
        };
        if (jobInfo.sql) out.sql = jobInfo.sql;
        return out;
      }
      if (status === 'failed' || status === 'cancelled') {
        const err = job.error || (job.result && job.result.error);
        const msg = (err && (err.message || err)) || job.error_message || ('Job ' + status);
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 2000);
    }
    throw new Error('查询轮询超时（' + Math.round(timeoutMs / 1000) + 's）');
  }

  /**
   * Resolve one dataset payload from /api/views/{id}/query.
   * Pass-through for sync / cached shapes; poll for async jobs.
   */
  async function resolveDataset(data, opts) {
    if (!data) throw new Error('dataset 无返回');
    if (data.error || data.error_message) {
      throw new Error(data.error_message || data.error);
    }
    if (data.error_kind) {
      throw new Error(data.error_message || data.error_kind);
    }
    if (data.mode === 'async' || data.job_id) {
      return pollGatewayJob(data, opts);
    }
    return data;
  }

  /**
   * Resolve all datasets in a /query JSON body → { name: {columns, rows} }.
   */
  async function resolveQueryResponse(json, opts) {
    const datasets = (json && json.datasets) || {};
    const out = {};
    const entries = Object.entries(datasets);
    await Promise.all(entries.map(async ([name, data]) => {
      out[name] = await resolveDataset(data, opts);
    }));
    return out;
  }

  global.DatasageAsyncQuery = {
    pollGatewayJob: pollGatewayJob,
    resolveDataset: resolveDataset,
    resolveQueryResponse: resolveQueryResponse,
  };
})(typeof window !== 'undefined' ? window : globalThis);
