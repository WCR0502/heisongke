/* =========================================================
   同频 MedEcho · 大模型客户端
   ---------------------------------------------------------
   浏览器只跟本机 /api/llm 说话，Key 永远不进前端。
   两种任务：
     LLM.triageQuestions({chief, history, round, maxRounds})
     LLM.triageReport({chief, history, redFlags})
   失败时抛带 code 的 Error，调用方据此决定要不要退回规则版。
   ========================================================= */
window.LLM = (function () {

  /* 接口基址：留空 = 同源（本地 server.js / Vercel 同域）
     线上跨域时由 config.js 的 llmBase 指定 Worker 地址 */
  const BASE = () => (window.APP_CONFIG && window.APP_CONFIG.llmBase) || '';

  const RETRYABLE = ['TIMEOUT', 'NETWORK', 'UPSTREAM', 'RATE_LIMIT'];
  const CLIENT_TIMEOUT = 32000;

  function fail(code, message, extra) {
    const e = new Error(message || code);
    e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
  }

  async function post(path, body, timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs || CLIENT_TIMEOUT);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      let json = null;
      try { json = await res.json(); } catch (e) { json = null; }

      if (!res.ok || !json || json.ok === false) {
        const code = (json && json.code) || (res.status === 504 ? 'TIMEOUT' : 'UPSTREAM');
        throw fail(code, (json && json.message) || ('接口返回 ' + res.status));
      }
      return json.data;
    } catch (e) {
      if (e.name === 'AbortError') throw fail('TIMEOUT', '浏览器等待超时');
      if (e.code) throw e;
      throw fail('NETWORK', e.message || '请求失败');
    } finally {
      clearTimeout(timer);
    }
  }

  async function withRetry(fn) {
    try {
      return await fn();
    } catch (e) {
      if (!RETRYABLE.includes(e.code)) throw e;
      await new Promise(r => setTimeout(r, 700));
      return await fn();
    }
  }

  /* 模型是否可用；任何异常都按"不可用"处理，页面绝不因此打不开 */
  async function status() {
    try {
      const res = await fetch(BASE() + '/api/llm/status', { cache: 'no-store' });
      if (!res.ok) return { ready: false, error: 'HTTP_' + res.status };
      return await res.json();
    } catch (e) {
      return { ready: false, error: 'NETWORK' };
    }
  }

  function triageQuestions(payload) {
    return withRetry(() => post(BASE() + '/api/llm', Object.assign({ task: 'questions' }, payload)));
  }

  function triageReport(payload) {
    return withRetry(() => post(BASE() + '/api/llm', Object.assign({ task: 'report' }, payload)));
  }

  return { status, triageQuestions, triageReport };
})();
