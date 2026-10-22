/**
 * 同频 MedEcho · 本地服务（零依赖）
 *   node server.js                  → http://localhost:5173
 *   set PORT=5180 && node server.js → 指定起始端口
 *
 * 两件事：
 *   1) 纯静态文件服务（症状梳理、追问、号源筛选都在浏览器本地完成）
 *   2) /api/llm 代理：把大模型 key 留在服务端，浏览器只调本地接口
 *
 * 端口被占用时：
 *   - 占用者是「同一个目录」的本服务 → 直接复用，打开页面后退出；
 *   - 占用者是别的东西（包括本项目的旧拷贝）→ 自动往后找空端口。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const START_PORT = Number(process.env.PORT) || 5173;
const MAX_TRIES = 10;
const ID = 'medecho';

const CONFIG_PATH = path.join(ROOT, 'llm.config.json');
const MAX_BODY = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8'
};

const isHealthPath = u => u === '/__medecho' || u === '/__medecho/';

/* =========================================================
   配置：只从磁盘读，key 永不发往浏览器
   ========================================================= */
let cfgCache = null;
let cfgStamp = 0;

function loadConfig() {
  let stamp = 0;
  try { stamp = fs.statSync(CONFIG_PATH).mtimeMs; } catch (e) { stamp = 0; }
  if (cfgCache && stamp === cfgStamp) return cfgCache;

  cfgStamp = stamp;
  if (!stamp) {
    cfgCache = { error: 'NO_CONFIG' };
    return cfgCache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cfgCache = {
      baseURL: String(raw.baseURL || '').trim().replace(/\/+$/, ''),
      model: String(raw.model || '').trim(),
      apiKey: String(raw.apiKey || '').trim(),
      provider: String(raw.provider || '').trim(),
      timeoutMs: Math.min(60000, Math.max(3000, Number(raw.timeoutMs) || 25000)),
      questionTokens: Math.min(2000, Math.max(120, Number(raw.questionTokens) || 500)),
      reportTokens: Math.min(3000, Math.max(200, Number(raw.reportTokens) || 900)),
      temperature: typeof raw.temperature === 'number' ? raw.temperature : 0.3
    };
    if (!cfgCache.baseURL || !cfgCache.model || !cfgCache.apiKey) cfgCache.error = 'BAD_CONFIG';
    return cfgCache;
  } catch (e) {
    cfgCache = { error: 'BAD_CONFIG' };
    return cfgCache;
  }
}

/* =========================================================
   高德 Web 服务（可选能力）：逆地理 + 周边医院搜索
   ---------------------------------------------------------
   Key 只放在服务端（llm.config.json 的 amapWebKey，或环境变量
   AMAP_WEB_KEY），浏览器永远拿不到。
   没配置时接口返回 NO_KEY，前端自动落回本地演示数据。
   ========================================================= */
let geoCache = null;
let geoStamp = -1;

function geoConfig() {
  let stamp = 0;
  try { stamp = fs.statSync(CONFIG_PATH).mtimeMs; } catch (e) { stamp = 0; }
  if (geoCache && stamp === geoStamp) return geoCache;

  geoStamp = stamp;
  let key = String(process.env.AMAP_WEB_KEY || '').trim();
  if (!key && stamp) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      key = String(raw.amapWebKey || '').trim();
    } catch (e) { /* 配置文件坏了就当没配 */ }
  }
  geoCache = { key };
  return geoCache;
}

function amapGet(pathname, params) {
  return new Promise((resolve, reject) => {
    const qs = Object.keys(params)
      .map(k => k + '=' + encodeURIComponent(params[k]))
      .join('&');
    const req = https.get('https://restapi.amap.com' + pathname + '?' + qs, { timeout: 8000 }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => {
        buf += d;
        if (buf.length > 512 * 1024) { req.destroy(); reject(new Error('高德返回内容过大')); }
      });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('高德返回了非 JSON 内容')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('高德接口超时')); });
    req.on('error', reject);
  });
}

/* =========================================================
   提示词（服务端持有，浏览器拿不到）
   ========================================================= */
const COMMON_RULES = [
  '你是一个面向听障人群的就医协作助手，只做「信息补全 + 分诊方向」，不做诊断。',
  '绝对不要给出确诊结论、处方、药物剂量，也不要说「你患了 X 病」。',
  '遇到急症信号（呼吸困难、意识改变、大量出血、疑似卒中/心梗、剧烈头痛、抽搐）必须优先提示急诊。',
  '语言要平实、短句，避免专业术语堆砌；不要使用表情符号。',
  '只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释性前后缀。'
].join('\n');

function messagesForQuestions(cfg, payload) {
  const history = (payload.history || []).map((h, i) =>
    `${i + 1}. 问：${h.question}\n   答：${h.answer}`
  ).join('\n');

  return [
    { role: 'system', content: COMMON_RULES + '\n\n' + [
      '当前任务是：生成下一轮追问。',
      '规则：',
      '1. 每轮输出 2 到 3 个问题，必须彼此不重复，也不要重复已经问过或用户已经答过的内容。',
      '2. 问题要围绕：部位与范围、起病时间与变化、性质与程度、伴随症状、既往史与用药。',
      '3. 用户已经明确说过或在回答里否定过的（例如「没有发烧」），不要再问。',
      '4. 问题必须是一句完整的中文问句，20 到 60 字之间，不要带编号和引号。',
      '5. 每个问题必须附带 3 到 4 个可直接点选的短选项：覆盖最常见的情况，每个选项 2 到 10 个字，',
      '   选项之间互斥，最后一个是「说不清」或「没有」这类兜底项。用户会直接点选项，所以选项要能替代打字。',
      '6. 如果现有信息已经足够做分诊方向判断，或已经是最后一轮，返回 done=true 且 questions 为空数组。',
      '输出格式：{"done":false,"questions":[{"label":"时间","question":"...","options":["3 天内","一周内","一个月内","说不清"]}]}',
      'label 只能取：位置 / 时间 / 性质 / 伴随 / 背景 之一。'
    ].join('\n') },
    { role: 'user', content: [
      `主诉：${payload.chief || ''}`,
      history ? `已有的问答：\n${history}` : '已有的问答：（暂无）',
      `这是第 ${payload.round} 轮，最多 ${payload.maxRounds} 轮。`
    ].join('\n\n') }
  ];
}

function messagesForReport(cfg, payload) {
  const history = (payload.history || []).map((h, i) =>
    `${i + 1}. 问：${h.question}\n   答：${h.answer}`
  ).join('\n');
  const flags = (payload.redFlags || []).join('、');

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
      `主诉：${payload.chief || ''}`,
      history ? `追问记录：\n${history}` : '追问记录：（无）',
      flags ? `本地规则已命中的危险信号：${flags}（这条必须体现为 emergency）` : ''
    ].filter(Boolean).join('\n\n') }
  ];
}

/* =========================================================
   调用模型
   ========================================================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function upstreamError(status, body) {
  let msg = '';
  try { msg = (JSON.parse(body).error || {}).message || ''; } catch (e) { msg = ''; }
  if (!msg) msg = String(body || '').slice(0, 200);
  if (status === 401 || status === 403) return { code: 'NO_KEY', message: '模型服务拒绝了这个 Key：' + msg };
  if (status === 429) return { code: 'RATE_LIMIT', message: '模型服务限流：' + msg };
  return { code: 'UPSTREAM', message: '模型服务返回 ' + status + '：' + msg };
}

async function postChat(cfg, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.baseURL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, text };
    return { ok: true, text };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, code: 'TIMEOUT', message: '模型响应超时（' + Math.round(cfg.timeoutMs / 1000) + ' 秒）' };
    return { ok: false, code: 'NETWORK', message: '连不上模型服务：' + (e.message || e.code || 'unknown') };
  } finally {
    clearTimeout(timer);
  }
}

async function askModel(cfg, messages, maxTokens) {
  const base = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: maxTokens
  };

  // 多数 OpenAI 兼容服务支持 json_object；部分中转不支持，400 时自动去掉重试
  let r = await postChat(cfg, Object.assign({ response_format: { type: 'json_object' } }, base));

  if (!r.ok && r.status === 400 && /response_format|json_object/i.test(r.text || '')) {
    r = await postChat(cfg, base);
  }

  // 网络类错误重试一次
  if (!r.ok && (r.code === 'TIMEOUT' || r.code === 'NETWORK')) {
    await sleep(600);
    r = await postChat(cfg, base);
  }

  if (!r.ok) {
    if (r.code) return { ok: false, code: r.code, message: r.message };
    return Object.assign({ ok: false }, upstreamError(r.status, r.text));
  }

  let data;
  try { data = JSON.parse(r.text); } catch (e) {
    return { ok: false, code: 'UPSTREAM', message: '模型服务返回了非 JSON 内容' };
  }

  const choice = (data.choices || [])[0] || {};
  const msg = choice.message || {};
  let content = msg.content;
  if (Array.isArray(content)) content = content.map(p => (p && p.text) || '').join('');
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, code: 'EMPTY', message: '模型没有返回内容' };
  }
  return { ok: true, content };
}

function extractJson(text) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

/* =========================================================
   结果校验：宁可报错，也不把脏数据放进页面
   ========================================================= */
const q = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

function validQuestions(obj, payload) {
  if (!obj || typeof obj !== 'object') return null;
  const asked = new Set((payload.history || []).map(h => q(h.question)));
  const done = obj.done === true;
  let list = Array.isArray(obj.questions) ? obj.questions : [];

  list = list.map(item => {
    const label = ['位置', '时间', '性质', '伴随', '背景'].includes(item && item.label) ? item.label : '追问';
    let options = (Array.isArray(item && item.options) ? item.options : [])
      .map(o => q(o)).filter(o => o && o.length <= 14).slice(0, 4);
    if (options.length < 2) options = OPT_FALLBACK[label] || OPT_FALLBACK['追问'];
    return { label, question: q(item && item.question), options };
  }).filter(item => item.question.length >= 6 && item.question.length <= 120)
    .filter(item => !asked.has(item.question))
    .slice(0, 3);

  if (done && !list.length) return { done: true, questions: [] };
  if (!list.length) return null;   // 既没说 done，也没给出可用问题 → 视为不合格
  return { done: false, questions: list };
}

/* 模型没给选项时的兜底：保证每题都能点选，不需要打字 */
const OPT_FALLBACK = {
  '位置': ['偏左边', '偏右边', '中间', '说不清'],
  '时间': ['3 天内', '一周内', '一个月内', '说不清'],
  '性质': ['胀痛', '刺痛', '烧灼感', '说不清'],
  '伴随': ['有发烧', '没有发烧', '说不清'],
  '背景': ['有慢性病', '没有慢性病', '说不清'],
  '追问': ['有', '没有', '说不清']
};

const PRIORITIES = ['emergency', 'soon', 'routine', 'observe'];

function validReport(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const summary = q(obj.summary);
  const depts = (Array.isArray(obj.depts) ? obj.depts : []).map(q).filter(Boolean).slice(0, 2);
  const systems = (Array.isArray(obj.systems) ? obj.systems : []).map(q).filter(Boolean).slice(0, 2);
  const priority = PRIORITIES.includes(obj.priority) ? obj.priority : 'routine';
  const bookingAdvice = q(obj.bookingAdvice);
  const homeAdvice = q(obj.homeAdvice);
  const redFlags = (Array.isArray(obj.redFlags) ? obj.redFlags : []).map(q).filter(Boolean).slice(0, 4);

  if (!summary || !depts.length) return null;
  return { summary, depts, systems, priority, bookingAdvice, homeAdvice, redFlags };
}

/* =========================================================
   路由
   ========================================================= */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function statusPayload() {
  const cfg = loadConfig();
  const ready = !cfg.error;
  let host = '';
  try { host = new URL(cfg.baseURL).host; } catch (e) { host = ''; }
  return {
    ready,
    error: cfg.error || null,
    provider: cfg.provider || host || '',
    model: cfg.model || '',
    endpoint: host
  };
}

async function handleLLM(req, res) {
  const cfg = loadConfig();
  if (cfg.error === 'NO_CONFIG') {
    return sendJson(res, 503, { ok: false, code: 'NO_CONFIG', message: '缺少 llm.config.json' });
  }
  if (cfg.error === 'BAD_CONFIG') {
    return sendJson(res, 503, { ok: false, code: 'BAD_CONFIG', message: 'llm.config.json 里 baseURL / model / apiKey 有缺项' });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', message: '请求体不是合法 JSON' });
  }

  const task = payload && payload.task;
  if (task !== 'questions' && task !== 'report') {
    return sendJson(res, 400, { ok: false, code: 'BAD_TASK', message: '未知的 task' });
  }

  const chief = q(payload.chief);
  if (!chief || chief.length > 600) {
    return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'chief 缺失或过长' });
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

  const messages = task === 'questions' ? messagesForQuestions(cfg, clean) : messagesForReport(cfg, clean);
  const maxTokens = task === 'questions' ? cfg.questionTokens : cfg.reportTokens;

  const got = await askModel(cfg, messages, maxTokens);
  if (!got.ok) return sendJson(res, got.code === 'TIMEOUT' ? 504 : 502, got);

  const obj = extractJson(got.content);
  const data = task === 'questions' ? validQuestions(obj, clean) : validReport(obj, clean);

  if (!data) {
    return sendJson(res, 502, { ok: false, code: 'BAD_SHAPE', message: '模型输出不符合约定格式，已丢弃' });
  }
  return sendJson(res, 200, { ok: true, task, data });
}

const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || '').split('?')[0]);

  if (isHealthPath(url)) {
    return sendJson(res, 200, { id: ID, root: ROOT });
  }

  if (url === '/api/llm/status') {
    return sendJson(res, 200, statusPayload());
  }

  if (url === '/api/llm') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'BAD_METHOD', message: '只接受 POST' });
    try {
      return await handleLLM(req, res);
    } catch (e) {
      if (e.message === 'body-too-large') return sendJson(res, 413, { ok: false, code: 'BAD_REQUEST', message: '请求体过大' });
      return sendJson(res, 500, { ok: false, code: 'SERVER', message: String(e.message || e) });
    }
  }

  if (url === '/api/geo/status') {
    return sendJson(res, 200, { ok: true, ready: !!geoConfig().key });
  }

  if (url === '/api/geo/regeo' || url === '/api/geo/around') {
    const key = geoConfig().key;
    if (!key) {
      return sendJson(res, 200, { ok: false, code: 'NO_KEY', message: '未配置高德 Web 服务 Key' });
    }

    const q = new URL(req.url, 'http://localhost').searchParams;
    const lng = Number(q.get('lng'));
    const lat = Number(q.get('lat'));
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return sendJson(res, 400, { ok: false, code: 'BAD_COORD', message: '经纬度不合法' });
    }

    try {
      if (url === '/api/geo/regeo') {
        const data = await amapGet('/v3/geocode/regeo', {
          location: lng + ',' + lat, key, radius: 800, extensions: 'all'
        });
        if (String(data.status) !== '1') {
          return sendJson(res, 200, { ok: false, code: 'AMAP_' + data.infocode, message: data.info });
        }
        const rg = data.regeocode || {};
        const comp = rg.addressComponent || {};
        // 高德把「没有的字段」返回成空数组 []，空数组是 truthy，必须显式取字符串
        const pick = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : '';
        const district = pick(comp.district);
        const cityName = pick(comp.city) || pick(comp.province);
        const city = (cityName + district) || pick(rg.formattedAddress) || '当前位置';
        const street = comp.streetNumber && typeof comp.streetNumber === 'string'
          ? comp.streetNumber
          : (comp.streetNumber && pick(comp.streetNumber.street)) || '';
        const address = pick(rg.formattedAddress)
          || [cityName, district, pick(comp.township), street].filter(Boolean).join('');
        return sendJson(res, 200, {
          ok: true,
          city,
          district,
          address: address || '当前位置'
        });
      }

      const radius = Math.max(500, Math.min(50000, Number(q.get('radius')) || 5000));

      /* 类型码由前端按「所选科目」决定，服务端只做白名单校验：
         090100 综合医院(含三甲/社区卫生服务中心)
         090202 口腔专科  090203 眼科专科
         不开放 090200（会带出医美+口腔）、090300（诊所）、090000（含药房） */
      const ALLOWED_TYPES = ['090100', '090100|090202', '090100|090203'];
      const reqTypes = String(q.get('types') || '').trim();
      const types = ALLOWED_TYPES.indexOf(reqTypes) >= 0 ? reqTypes : '090100';

      const data = await amapGet('/v3/place/around', {
        location: lng + ',' + lat, key, radius,
        offset: 25, page: 1, sortrule: 'distance',
        types,
        extensions: 'base'
      });
      if (String(data.status) !== '1') {
        return sendJson(res, 200, { ok: false, code: 'AMAP_' + data.infocode, message: data.info });
      }
      const places = (data.pois || []).map(p => {
        const [plng, plat] = String(p.location || '').split(',').map(Number);
        if (!Number.isFinite(plng) || !Number.isFinite(plat)) return null;
        return {
          id: 'amap-' + (p.id || p.name),
          name: p.name,
          address: typeof p.address === 'string' ? p.address : '',
          coord: [plng, plat],
          distance: Number(p.distance) || 0
        };
      }).filter(Boolean);
      return sendJson(res, 200, { ok: true, places });
    } catch (e) {
      return sendJson(res, 200, { ok: false, code: 'NETWORK', message: String(e.message || e) });
    }
  }

  if (req.method !== 'GET') { res.writeHead(405); return res.end('method not allowed'); }

  let file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
});

function openBrowser(url) {
  try {
    const { exec } = require('child_process');
    if (process.platform === 'win32') exec('start "" "' + url + '"');
    else if (process.platform === 'darwin') exec('open "' + url + '"');
    else exec('xdg-open "' + url + '"');
  } catch (e) { /* 浏览器没打开也不影响服务 */ }
}

const AUTO_OPEN = process.env.OPEN === '1' || process.argv.includes('--open');

/* ---------------- 端口探测 ---------------- */
const same = p => path.resolve(p) === path.resolve(ROOT);

function probe(port) {
  return new Promise(resolve => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/__medecho', timeout: 1200 },
      res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data && data.id === ID && same(data.root) ? 'same' : 'other');
          } catch (e) { resolve('other'); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); resolve('other'); });
    req.on('error', () => resolve('other'));
  });
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const onError = err => { server.removeListener('listening', onOk); reject(err); };
    const onOk = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(port);
  });
}

function banner(port, note) {
  const url = 'http://localhost:' + port;
  const llm = statusPayload();
  console.log('');
  console.log('  同频 MedEcho 已启动');
  console.log('  → ' + url);
  if (note) console.log('  ' + note);
  if (llm.ready) console.log('  模型：' + (llm.model || '?') + (llm.endpoint ? '  @ ' + llm.endpoint : ''));
  else console.log('  模型：未接入（' + (llm.error === 'NO_CONFIG' ? '缺少 llm.config.json' : 'llm.config.json 配置不完整') + '），使用本地规则分诊');
  console.log('');
  console.log('  关闭这个窗口 = 停止服务');
  console.log('');
  if (AUTO_OPEN) setTimeout(() => openBrowser(url), 500);
}

async function start(port, left) {
  if (left <= 0) {
    console.log('');
    console.log('  从 ' + START_PORT + ' 起的 ' + MAX_TRIES + ' 个端口都被占用。');
    console.log('  换一段端口再启动： set PORT=5280 && node server.js');
    process.exit(1);
  }

  try {
    await listen(port);
    banner(port, port !== START_PORT ? '（' + START_PORT + ' 被占用，已自动改用 ' + port + '）' : '');
    return;
  } catch (err) {
    if (err.code !== 'EADDRINUSE') {
      console.error('');
      console.error('  服务启动失败：' + err.message);
      process.exit(1);
    }
  }

  const state = await probe(port);

  if (state === 'same') {
    console.log('');
    console.log('  这个目录的服务已经在 ' + port + ' 端口运行，不用重复启动。');
    console.log('  → http://localhost:' + port);
    console.log('');
    if (AUTO_OPEN) openBrowser('http://localhost:' + port);
    setTimeout(() => process.exit(0), 400);
    return;
  }

  console.log('  端口 ' + port + ' 被其他程序（可能是本项目的旧拷贝）占用，试 ' + (port + 1) + ' …');
  start(port + 1, left - 1);
}

start(START_PORT, MAX_TRIES);
