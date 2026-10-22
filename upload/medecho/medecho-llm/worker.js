/* =========================================================
   同频 MedEcho · AI 代理（Cloudflare Worker）
   ---------------------------------------------------------
   作用：代替本地 server.js 的 /api/llm 路由。
   Key 只存在 Worker 的环境变量（secret）里，浏览器拿不到。

   环境变量：
     LLM_BASE_URL  模型接口地址，如 https://api.openai-next.com/v1
     LLM_MODEL     模型名，如 qwen-flash
     LLM_API_KEY   密钥，用 wrangler secret 写入，不要写进文件
   ========================================================= */

const COMMON_RULES = [
  '你是一个面向听障人群的就医协作助手，只做「信息补全 + 分诊方向」，不做诊断。',
  '绝对不要给出确诊结论、处方、药物剂量，也不要说「你患了 X 病」。',
  '遇到急症信号（呼吸困难、意识改变、大量出血、疑似卒中/心梗、剧烈头痛、抽搐）必须优先提示急诊。',
  '语言要平实、短句，避免专业术语堆砌；不要使用表情符号。',
  '只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释性前后缀。'
].join('\n');

const q = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/* ---------------- 提示词（服务端持有） ---------------- */

function messagesForQuestions(p) {
  const history = (p.history || []).map((h, i) => `${i + 1}. 问：${h.question}\n   答：${h.answer}`).join('\n');
  return [
    { role: 'system', content: COMMON_RULES + '\n\n' + [
      '当前任务是：生成下一轮追问。',
      '规则：',
      '1. 每轮输出 2 到 3 个问题，必须彼此不重复，也不要重复已经问过或用户已经答过的内容。',
      '2. 问题要围绕：部位与范围、起病时间与变化、性质与程度、伴随症状、既往史与用药。',
      '3. 用户已经明确说过或在回答里否定过的（例如「没有发烧」），不要再问。',
      '4. 问题必须是一句完整的中文问句，20 到 60 字之间，不要带编号和引号。',
      '5. 每个问题必须附带 3 到 4 个可直接点选的短选项：覆盖最常见的情况，每个选项 2 到 10 个字，',
      '   选项之间互斥，最后一个是「说不清」或「没有」这类兜底项。',
      '6. 如果现有信息已经足够做分诊方向判断，或已经是最后一轮，返回 done=true 且 questions 为空数组。',
      '输出格式：{"done":false,"questions":[{"label":"时间","question":"...","options":["3 天内","一周内","一个月内","说不清"]}]}',
      'label 只能取：位置 / 时间 / 性质 / 伴随 / 背景 之一。'
    ].join('\n') },
    { role: 'user', content: [
      `主诉：${p.chief || ''}`,
      history ? `已有的问答：\n${history}` : '已有的问答：（暂无）',
      `这是第 ${p.round} 轮，最多 ${p.maxRounds} 轮。`
    ].join('\n\n') }
  ];
}

function messagesForReport(p) {
  const history = (p.history || []).map((h, i) => `${i + 1}. 问：${h.question}\n   答：${h.answer}`).join('\n');
  const flags = (p.redFlags || []).join('、');
  return [
    { role: 'system', content: COMMON_RULES + '\n\n' + [
      '当前任务是：把上面这段问诊整理成一份就诊摘要，并给出分诊方向。',
      '输出字段：',
      '- summary：一句话复述主诉与关键补充，不超过 80 字，客观陈述，不加判断。',
      '- depts：建议就诊的科室，1 到 2 个，中文标准科室名（如 消化内科、神经内科、全科医学科）。',
      '- systems：对应的人体系统，1 到 2 个（如 消化系统、神经系统）。',
      '- priority：只能是 emergency / soon / routine / observe 之一。',
      '  emergency＝需要立即急诊；soon＝1 到 3 天内门诊；routine＝近期普通门诊；observe＝可先居家观察 1 到 2 天。',
      '- bookingAdvice：就医建议，40 到 80 字，说明挂什么科、多久内去、带什么材料。',
      '- homeAdvice：居家注意，40 到 80 字，只写安全的生活建议，不写药物。',
      '- redFlags：出现哪些情况必须立刻急诊，2 到 4 条，每条不超过 25 字。',
      '输出格式：{"summary":"","depts":[],"systems":[],"priority":"routine","bookingAdvice":"","homeAdvice":"","redFlags":[]}'
    ].join('\n\n') },
    { role: 'user', content: [
      `主诉：${p.chief || ''}`,
      history ? `追问记录：\n${history}` : '追问记录：（无）',
      flags ? `本地规则已命中的危险信号：${flags}（这条必须体现为 emergency）` : ''
    ].filter(Boolean).join('\n\n') }
  ];
}

/* ---------------- 调用模型 ---------------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function postChat(cfg, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, text };
    return { ok: true, text };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, code: 'TIMEOUT', message: '模型响应超时' };
    return { ok: false, code: 'NETWORK', message: '连不上模型服务：' + (e.message || e.code || 'unknown') };
  } finally { clearTimeout(timer); }
}

async function askModel(cfg, messages, maxTokens) {
  const base = { model: cfg.model, messages, temperature: cfg.temperature, max_tokens: maxTokens };

  let r = await postChat(cfg, Object.assign({ response_format: { type: 'json_object' } }, base));
  if (!r.ok && r.status === 400 && /response_format|json_object/i.test(r.text || '')) r = await postChat(cfg, base);
  if (!r.ok && (r.code === 'TIMEOUT' || r.code === 'NETWORK')) { await sleep(600); r = await postChat(cfg, base); }

  if (!r.ok) {
    if (r.code) return { ok: false, code: r.code, message: r.message };
    let msg = '';
    try { msg = (JSON.parse(r.text).error || {}).message || ''; } catch (e) { msg = String(r.text || '').slice(0, 200); }
    if (r.status === 401 || r.status === 403) return { ok: false, code: 'NO_KEY', message: '模型服务拒绝了这个 Key：' + msg };
    if (r.status === 429) return { ok: false, code: 'RATE_LIMIT', message: '模型服务限流：' + msg };
    return { ok: false, code: 'UPSTREAM', message: '模型服务返回 ' + r.status + '：' + msg };
  }

  let data;
  try { data = JSON.parse(r.text); } catch (e) { return { ok: false, code: 'UPSTREAM', message: '模型服务返回了非 JSON 内容' }; }

  const msg0 = ((data.choices || [])[0] || {}).message || {};
  let content = msg0.content;
  if (Array.isArray(content)) content = content.map(x => (x && x.text) || '').join('');
  if (typeof content !== 'string' || !content.trim()) return { ok: false, code: 'EMPTY', message: '模型没有返回内容' };
  return { ok: true, content };
}

function extractJson(text) {
  let s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

/* ---------------- 结果校验：不合格就丢弃 ---------------- */

const OPT_FALLBACK = {
  '位置': ['偏左边', '偏右边', '中间', '说不清'],
  '时间': ['3 天内', '一周内', '一个月内', '说不清'],
  '性质': ['胀痛', '刺痛', '烧灼感', '说不清'],
  '伴随': ['有发烧', '没有发烧', '说不清'],
  '背景': ['有慢性病', '没有慢性病', '说不清'],
  '追问': ['有', '没有', '说不清']
};

function validQuestions(obj, p) {
  if (!obj || typeof obj !== 'object') return null;
  const asked = new Set((p.history || []).map(h => q(h.question)));
  const done = obj.done === true;

  const list = (Array.isArray(obj.questions) ? obj.questions : []).map(item => {
    const label = ['位置', '时间', '性质', '伴随', '背景'].includes(item && item.label) ? item.label : '追问';
    let options = (Array.isArray(item && item.options) ? item.options : [])
      .map(q).filter(o => o && o.length <= 14).slice(0, 4);
    if (options.length < 2) options = OPT_FALLBACK[label] || OPT_FALLBACK['追问'];
    return { label, question: q(item && item.question), options };
  })
    .filter(i => i.question.length >= 6 && i.question.length <= 120)
    .filter(i => !asked.has(i.question))
    .slice(0, 3);

  if (done && !list.length) return { done: true, questions: [] };
  if (!list.length) return null;
  return { done: false, questions: list };
}

function validReport(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const summary = q(obj.summary);
  const depts = (Array.isArray(obj.depts) ? obj.depts : []).map(q).filter(Boolean).slice(0, 2);
  if (!summary || !depts.length) return null;
  return {
    summary,
    depts,
    systems: (Array.isArray(obj.systems) ? obj.systems : []).map(q).filter(Boolean).slice(0, 2),
    priority: ['emergency', 'soon', 'routine', 'observe'].includes(obj.priority) ? obj.priority : 'routine',
    bookingAdvice: q(obj.bookingAdvice),
    homeAdvice: q(obj.homeAdvice),
    redFlags: (Array.isArray(obj.redFlags) ? obj.redFlags : []).map(q).filter(Boolean).slice(0, 4)
  };
}

/* ---------------- HTTP（带 CORS，供 GitHub Pages 跨域调用） ---------------- */

function json(obj, code) {
  return new Response(JSON.stringify(obj), {
    status: code || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    }
  });
}

export default {
  async fetch(request, env) {
    // 浏览器跨域前会先发 OPTIONS 预检，必须放行
    if (request.method === 'OPTIONS') return json({ ok: true });

    const url = new URL(request.url);
    const cfg = {
      baseURL: String(env.LLM_BASE_URL || '').trim().replace(/\/+$/, ''),
      model: String(env.LLM_MODEL || '').trim(),
      apiKey: String(env.LLM_API_KEY || '').trim(),
      timeoutMs: 25000,
      questionTokens: 500,
      reportTokens: 900,
      temperature: 0.3
    };

    if (url.pathname === '/api/llm/status') {
      let host = '';
      try { host = new URL(cfg.baseURL).host; } catch (e) { host = ''; }
      const ready = !!(cfg.baseURL && cfg.model && cfg.apiKey);
      return json({
        ready,
        error: ready ? null : 'BAD_CONFIG',
        provider: host,
        model: cfg.model,
        endpoint: host
      });
    }

    if (url.pathname !== '/api/llm') return json({ ok: false, code: 'NOT_FOUND', message: '未知路径' }, 404);
    if (request.method !== 'POST') return json({ ok: false, code: 'BAD_METHOD', message: '只接受 POST' }, 405);
    if (!cfg.apiKey) return json({ ok: false, code: 'NO_KEY', message: 'Worker 未配置 LLM_API_KEY' }, 503);

    let payload;
    try { payload = JSON.parse(await request.text()); }
    catch (e) { return json({ ok: false, code: 'BAD_REQUEST', message: '请求体不是合法 JSON' }, 400); }

    const task = payload && payload.task;
    if (task !== 'questions' && task !== 'report') {
      return json({ ok: false, code: 'BAD_TASK', message: '未知的 task' }, 400);
    }

    const chief = q(payload.chief);
    if (!chief || chief.length > 600) {
      return json({ ok: false, code: 'BAD_REQUEST', message: 'chief 缺失或过长' }, 400);
    }

    const clean = {
      chief,
      history: (Array.isArray(payload.history) ? payload.history : []).slice(0, 12).map(h => ({
        question: q(h && h.question).slice(0, 200),
        answer: q(h && h.answer).slice(0, 500)
      })),
      round: Math.min(6, Math.max(1, Number(payload.round) || 1)),
      maxRounds: Math.min(6, Math.max(1, Number(payload.maxRounds) || 3)),
      redFlags: (Array.isArray(payload.redFlags) ? payload.redFlags : []).map(q).filter(Boolean).slice(0, 6)
    };

    const messages = task === 'questions' ? messagesForQuestions(clean) : messagesForReport(clean);
    const maxTokens = task === 'questions' ? cfg.questionTokens : cfg.reportTokens;

    const got = await askModel(cfg, messages, maxTokens);
    if (!got.ok) return json(got, got.code === 'TIMEOUT' ? 504 : 502);

    const obj = extractJson(got.content);
    const data = task === 'questions' ? validQuestions(obj, clean) : validReport(obj, clean);
    if (!data) return json({ ok: false, code: 'BAD_SHAPE', message: '模型输出不符合约定格式，已丢弃' }, 502);

    return json({ ok: true, task, data });
  }
};
