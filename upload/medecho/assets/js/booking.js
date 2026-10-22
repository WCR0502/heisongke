/* 同频 MedEcho · 症状梳理、医院定位与号源筛选
   ---------------------------------------------------------
   号源来源规则（唯一事实来源）：
   1. 号源只能由「本次定位 + 当前搜索半径」返回的医院 POI 生成；
   2. 每条号源携带 hospitalId，医生由 hospitalId 派生，医院与医生强绑定；
   3. 筛选、地图高亮、弹窗核对共用 state.hospitalId，不做跨院兜底。
*/
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const MAX_HOSPITALS = 10;   // 只取最近 10 家，列表与筛选范围保持一致

  /* ---------------- 分页切换（一屏一件事） ---------------- */
  const SCREEN_ORDER = ['start', 'ask', 'result', 'hospital', 'record'];

  // 模型状态探测的 promise：提交时等它，避免手快误走规则版
  let modelReady = Promise.resolve();

  function go(name) {
    if (!SCREEN_ORDER.includes(name)) return;

    document.querySelectorAll('.screen').forEach(el => {
      el.classList.toggle('active', el.dataset.screen === name);
    });

    const idx = SCREEN_ORDER.indexOf(name);
    document.querySelectorAll('.stepbar .step').forEach(el => {
      const i = SCREEN_ORDER.indexOf(el.dataset.step);
      el.classList.toggle('on', i === idx);
      el.classList.toggle('done', i < idx);
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
    try { history.replaceState(null, '', '#' + name); } catch (e) {}

    if (name === 'hospital') { renderDeptFilter(); updateFindTag(activeDept()); }

    if (name === 'ask') {
      setTimeout(() => {
        const input = $('followupInput');
        if (input && !input.disabled) input.focus({ preventScroll: true });
      }, 280);
    }
  }

  const state = {
    chief: '',
    question: '',
    meta: null,         // 当前追问：{ key, label, question }
    step: 0,
    history: [],        // [{ key, label, question, answer }]
    depts: [],
    systems: [],        // 匹配到的人体系统，用于分诊说明与警示清单
    priority: 'routine', // emergency | soon | routine | observe
    urgent: false,
    location: null,     // { coord, city, address }
    radius: 5000,
    hospitals: [],      // 当前定位范围内、已过滤的医院 POI
    hospitalId: 'all',  // 唯一选中态：'all' 或医院 id
    deptFilter: '',     // 从结果页点科室带过来的筛选：'' 表示不限
    slots: [],           // 从 hospitals 生成，唯一号源来源

    /* --- 大模型 --- */
    aiReady: false,      // 启动时探测到的模型可用性
    aiMode: false,       // 本次梳理是否走 AI
    aiModel: '',
    aiRound: 0,          // 已完成的 AI 轮次
    aiQueue: [],         // 当前轮剩余待问问题
    busy: false,         // AI 请求进行中
    target: 5,           // 进度条总格数（AI 模式下为估算值）

    /* --- 就诊档案 --- */
    chosenSlotId: '',
    record: null,        // { dept, hospital, doctor, when, ride, questions[], orders[], recite }
    shareMode: false
  };

  /* ---------------- 科室与医生 ---------------- */
  // [职称, 专长, 挂号费]
  const CLINIC = {
    '心血管内科': ['主任医师', '冠心病与高血压门诊', 50],
    '消化内科': ['副主任医师', '胃肠疾病门诊', 35],
    '神经内科': ['主任医师', '头痛与眩晕门诊', 60],
    '骨科': ['主任医师', '脊柱与关节门诊', 50],
    '呼吸内科': ['副主任医师', '咳嗽与气道门诊', 35],
    '皮肤科': ['副主任医师', '皮炎与过敏门诊', 30],
    '全科医学科': ['主治医师', '常见症状初诊', 15],
    '妇科': ['主治医师', '妇科门诊', 35],
    '泌尿外科': ['副主任医师', '泌尿外科门诊', 40],
    '眼科': ['副主任医师', '眼科门诊', 35],
    '耳鼻咽喉科': ['副主任医师', '耳鼻咽喉门诊', 35],
    '精神心理科': ['副主任医师', '情绪与睡眠门诊', 40],
    '内分泌科': ['副主任医师', '代谢与甲状腺门诊', 35]
  };

  const SURNAME = ['林', '周', '陈', '顾', '许', '唐', '沈', '宋', '韩', '邵', '程', '叶'];
  const GIVEN = ['知远', '予安', '一禾', '闻溪', '明川', '书言', '嘉禾', '清和', '望舒', '亦然', '静川', '怀瑾'];

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // 医生由「医院 + 科室」派生：同一家医院的不同科室不会串，不同医院也不会重名复用
  function doctorFor(hospitalId, dept) {
    const seed = hash(hospitalId + '|' + dept);
    const clinic = CLINIC[dept] || ['主治医师', `${dept}门诊`, 20];
    return {
      name: SURNAME[seed % SURNAME.length] + GIVEN[(seed >>> 5) % GIVEN.length],
      title: clinic[0],
      specialty: clinic[1],
      price: clinic[2]
    };
  }

  /* ---------------- 分诊：人体系统 → 科室（只做方向，不做诊断） ---------------- */
  const DEPT_RULES = [
    ['心血管内科', '心血管系统', /胸闷|胸痛|胸口痛|心慌|心悸|心跳快|心脏|气短|憋气|冠心病|高血压/],
    ['神经内科', '神经系统', /头晕|眩晕|头痛|头疼|麻木|发麻|麻(?!烦)|手抖|偏头痛|耳鸣|面部抽动|脸麻/],
    ['消化内科', '消化系统', /腹痛|肚子疼|胃痛|胃疼|胃胀|胃炎|反酸|烧心|恶心|呕吐|腹泻|便秘|便血|上腹|腹胀/],
    ['呼吸内科', '呼吸系统', /咳嗽|咳痰|发热|发烧|气喘|呼吸道|咽痛|喉咙痛|肺炎|气促/],
    ['骨科', '运动系统', /腰痛|腰疼|腿痛|膝痛|关节痛|肩痛|颈椎|扭伤|骨折|脖子疼|足跟/],
    ['皮肤科', '皮肤', /皮疹|皮肤|湿疹|瘙痒|荨麻疹|红斑|脱发|痘/],
    ['妇科', '生殖系统', /月经|痛经|白带|妇科|怀孕|经期|更年期/],
    ['泌尿外科', '泌尿系统', /尿频|尿急|尿痛|血尿|泌尿|前列腺|排尿/],
    ['眼科', '眼', /眼睛|视力|眼痛|红眼|视物模糊|眼干|流泪/],
    ['耳鼻咽喉科', '耳鼻咽喉', /耳朵|鼻塞|鼻炎|咽喉|吞咽|耳闷|流鼻血|声音嘶哑/],
    ['精神心理科', '精神心理', /情绪|焦虑|抑郁|强迫|失眠|睡不着|心情低落|烦躁|压力大|胡思乱想/],
    ['内分泌科', '内分泌代谢', /血糖|糖尿病|口渴|多尿|体重下降|甲状腺|怕冷|怕热|多汗/]
  ];

  function matchTriage(text) {
    const hits = DEPT_RULES.filter(([, , re]) => re.test(text));
    if (!hits.length) return { depts: ['全科医学科'], systems: ['全身一般情况'] };
    return {
      depts: [...new Set(hits.map(h => h[0]))],
      systems: [...new Set(hits.map(h => h[1]))]
    };
  }

  /* ---------------- 阶段 1：危险红线 ---------------- */
  const RED_FLAGS = [
    ['呼吸困难', /严重呼吸困难|喘不上气|喘不过气|说不出完整句子|嘴唇发紫|窒息/],
    ['意识改变', /昏迷|失去意识|意识不清|叫不醒|晕厥|突然晕倒/],
    ['大量出血', /大出血|大量出血|止不住的血|呕血|吐血|咳血|黑便/],
    ['疑似卒中', /(?:一侧|单侧|半边|手脚|肢体|左手|右手|左腿|右腿|左边|右边).{0,6}(?:无力|没力|麻木|使不上力|不能动)|口角歪斜|嘴歪|言语不清|说话不清|吐字不清/],
    ['疑似心梗', /胸痛|胸口痛|胸闷.{0,12}(?:冷汗|大汗|喘不上气|晕厥)|(?:冷汗|大汗|喘不上气|晕厥).{0,12}胸闷/],
    ['剧烈头痛', /剧烈头痛|炸裂样头痛|头痛.{0,6}(?:最严重|从没有过)/],
    ['抽搐', /抽搐|抽风|癫痫发作/]
  ];

  const NEG_RE = /(?:没有|并无|未见|未出现|不伴|否认|无明显|不再|没觉得|没有出现|无)(?:[\u4e00-\u9fff]{0,3})\s*$/;

  function hitRedFlag(text, re) {
    const t = String(text || '');
    // 用全局副本逐次前进，避免非全局正则 exec 原地打转（否定句会卡死）
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(t)) !== null) {
      if (!NEG_RE.test(t.slice(Math.max(0, m.index - 12), m.index))) return true;
      if (m[0].length === 0) g.lastIndex++;
    }
    return false;
  }

  function redFlagLabels(text) {
    return RED_FLAGS.filter(([, re]) => hitRedFlag(text, re)).map(([label]) => label);
  }

  function detectUrgency(text) {
    return redFlagLabels(text).length > 0;
  }

  /* ---------------- 阶段 2：追问（缺哪块信息问哪块） ---------------- */
  const MAX_FOLLOWUPS = 5;   // 最多 5 条追问

  // 只看主诉与用户回答；追问句子本身不参与匹配，避免把问题里的词当成症状
  const allText = () => [state.chief, ...state.history.map(x => x.answer)].join(' ');
  // 去掉「没有胸闷」这类否定分句，避免把否定描述当成已知信息
  const positiveText = () => allText().replace(/(?:没有|并无|未见|未出现|不伴|否认|无明显|不再)[^，。；、]{0,8}/g, ' ');

  const ONSET_RE = /(一下子|突然|突发|猛地|慢慢|逐渐|好几天|\d+\s*(?:天|周|个月|小时|年)|今天|昨天|前天|最近|早上|晚上|一直|持续)/;
  const NEURO_RED_RE = /(手脚无力|肢体无力|嘴歪|口角歪|说话不清|言语不清|剧烈头痛|胸闷|胸痛|半边)/;
  const DENY_RED_RE = /(没有|无|不伴|否认)[^。；]{0,8}(无力|麻木|说话不清|胸闷|胸痛|剧烈头痛|出血)/;

  // 红线先问：起病方式 + 是否伴随神经/心肺高危表现；二者都有信息就不再重复问
  function redFlagQuestion() {
    const text = allText();
    const onsetKnown = ONSET_RE.test(text);
    const companionKnown = NEURO_RED_RE.test(text) || DENY_RED_RE.test(text);
    if (onsetKnown && companionKnown) return null;
    if (!onsetKnown) {
      return {
        key: 'red-onset', label: '红线',
        question: '这个症状是一下子出现的，还是慢慢加重的？',
        options: ['一下子出现', '慢慢加重', '说不清']
      };
    }
    return {
      key: 'red-companion', label: '红线',
      question: '有没有手脚无力、说话不清、胸闷或剧烈头痛？',
      options: ['都没有', '有手脚无力', '说话不清', '有胸闷或剧烈头痛']
    };
  }

  const SYSTEMIC_RE = /(发烧|发热|乏力|全身|失眠|睡不着|情绪|焦虑|抑郁|体重|食欲|出汗|恶心)/;
  const LOC_RE = /(左边|右边|左侧|右侧|两侧|双侧|半边|单侧|全脸|上腹|下腹|小腹|脐|后脑|太阳穴|前额|颈|肩|上背|腰|膝|踝|手腕|局部|范围)|(?:头(?!晕)|脸|眼|耳|鼻|咽|喉|胸|背|腹|胃|腿|脚|手|臂|关节|皮肤|牙)/;
  const LOCAL_RE = /(咳|痰|呼吸|气短|气促|鼻|咽|喉|眼|耳|皮|关节|腹|胃|胸|背|腰|头|脸|腿|膝|脚|手|臂|颈|肩|牙|尿|月经|便)/;
  const PAIN_RE = /(痛|疼|麻|酸|胀|紧|烧灼|灼热|痒|晕|心慌|闷|抽)/;
  const TIME_RE = /(什么时候|从.{0,8}开始|持续|\d+\s*(?:天|周|个月|小时|年)|[一二三四五六七八九十两]+\s*(?:天|周|个月|小时|年)|今天|昨天|前天|最近|几天|一阵一阵|反复|每次|每晚)/;
  const NATURE_RE = /(麻木|发麻|刺痛|针扎|胀痛|隐痛|绞痛|灼痛|烧灼|跳痛|钝痛|闷痛|酸痛|酸胀|撕裂|压迫|发紧|发凉|瘙痒|痒|心慌|头晕|发沉|烧心|闷|胀)/;
  const ASSOC_RE = /(发热|发烧|恶心|呕吐|出汗|气短|头晕|乏力|失眠|睡不着|没有其他|无其他|其他正常|食欲|体重)/;
  const HX_RE = /(慢性病|高血压|糖尿病|冠心病|病史|以前|曾经|长期|正在吃|服用|药物|吃药|过敏|手术|检查|看过医生|没有基础病)/;

  const CATEGORY_RULES = [
    { key: 'loc', label: '位置', ok: t => SYSTEMIC_RE.test(t) || LOC_RE.test(t) || LOCAL_RE.test(t), question: '不舒服的部位具体在哪里？', options: ['偏左边', '偏右边', '中间', '说不清'] },
    { key: 'time', label: '时间', ok: t => TIME_RE.test(t), question: '这些症状从什么时候开始？到现在多久了？', options: ['3 天内', '一周内', '一个月内', '说不清'] },
    { key: 'nature', label: '性质', ok: t => !PAIN_RE.test(t) || NATURE_RE.test(t), question: '是什么感觉？', options: ['胀痛', '刺痛', '烧灼感', '说不清'] },
    { key: 'assoc', label: '伴随', ok: t => ASSOC_RE.test(t), question: '还有其他不舒服吗？', options: ['有发烧', '有恶心呕吐', '没有其他', '说不清'] },
    { key: 'hx', label: '背景', ok: t => HX_RE.test(t), question: '有慢性病或长期在吃的药吗？', options: ['有慢性病', '没有慢性病', '说不清'] }
  ];

  function questionForStep(askedKeys) {
    const text = positiveText();
    const next = CATEGORY_RULES.find(c => !askedKeys.has(c.key) && !c.ok(text));
    return next ? { key: next.key, label: next.label, question: next.question, options: next.options } : null;
  }

  function catTag(label) {
    return `<span class="tx-tag cat${label === '红线' ? ' red' : ''}">${esc(label || '追问')}</span>`;
  }

  /* ---------------- 追问记录渲染（大字号问答列表） ---------------- */
  function renderTranscript() {
    const host = $('followupTranscript');
    if (!host) return;

    if (!state.chief) { host.innerHTML = ''; return; }

    const items = state.history.map((item, i) => `
      <div class="said-item">
        <div class="q"><b>问${i + 1}：</b>${esc(item.question)}</div>
        <div class="a"><b>你答：</b>${esc(item.answer)}</div>
      </div>`).join('');

    host.innerHTML = `<div class="said-chief"><b>你说的</b>${esc(state.chief)}</div>${items}`;

    const count = $('answeredCount');
    if (count) count.textContent = state.history.length;
  }

  function renderMeter(activeIndex) {
    const meter = $('followupMeter');
    if (!meter) return;
    // activeIndex < 0 表示已结束：只保留实际记录条数，全部点亮
    const total = activeIndex < 0 ? Math.max(state.history.length, 1) : (state.target || MAX_FOLLOWUPS);
    meter.innerHTML = Array.from({ length: total }, (_, i) => {
      const cls = i < state.history.length ? 'on' : (i === activeIndex ? 'now' : '');
      return `<i class="${cls}"></i>`;
    }).join('');
  }

  function summaryText() {
    const details = state.history.map(x => x.answer).filter(Boolean);
    return `主诉：${state.chief}${details.length ? '；补充：' + details.join('；') : ''}`;
  }

  /* ---------------- 阶段 3：就诊方向 + 优先级 ---------------- */
  const PRIORITY = {
    emergency: { title: '马上打 120 或去急诊', text: '你说的情况里有需要马上处理的信号，别等门诊，也别自己开车去。', action: '先急救，普通号源暂时不显示' },
    soon: { title: '1 到 3 天内去看门诊', text: '症状有持续或加重的迹象，这几天内去医院看看，别硬拖。', action: '挂对应科室，约在 3 天内' },
    routine: { title: '最近去看个门诊', text: '目前没看到紧急信号，按平常节奏挂号就行。', action: '挑方便的时间去' },
    observe: { title: '可以先在家观察 1 到 2 天', text: '看起来比较轻，先休息观察，记下变化。', action: '不好转再去医院' }
  };

  function assessPriority() {
    if (state.urgent) return 'emergency';
    const t = allText();
    // 「饭后加重」这类诱因描述不算恶化，只有持续/进行性加重才升级为尽快就诊
    if (/(?:持续|明显|逐渐|越来越|一天比一天|最近|这几天|这两天|今天)(?:[^，。；]{0,4})?加重|加重了|越来越|更严重|受不了|影响睡|影响工作|走不了|持续不缓解|反复|频繁|发烧|发热|疼得|没胃口|瘦了/.test(t)) return 'soon';
    if (/(轻微|一点点|偶尔|一过性|短暂|已经好了|好多了|不影响)/.test(t)) return 'observe';
    return 'routine';
  }

  function updateUrgency() {
    state.priority = assessPriority();
    const card = $('urgencyCard');
    card.classList.toggle('urgent', state.priority === 'emergency');
    card.classList.toggle('soon', state.priority === 'soon');
    const info = PRIORITY[state.priority];
    $('urgencyTitle').textContent = info.title;
    $('urgencyText').textContent = info.text;
    $('urgencyAction').textContent = info.action;

    // 急诊模式：结果页压缩成一屏三步，不让人在紧急时翻卡片
    const emergency = state.priority === 'emergency';
    $('results').classList.toggle('is-emergency', emergency);
    if (emergency) {
      const chief = (state.chief || '').replace(/\s+/g, '');
      const tAns = (state.history.find(h => /时间/.test(h.label)) || {}).answer || '';
      const when = /说不清|不清楚/.test(tAns) ? '' : tAns;
      $('emgSay').textContent = `「${chief.slice(0, 26)}${chief.length > 26 ? '…' : ''}」` +
        (when ? `，${when}开始` : '') + ' —— 把这句话直接给医生看。';
    }
  }

  /* ---------------- 阶段 4：分层建议 ---------------- */
  const SYSTEM_WARNINGS = {
    '神经系统': '突然一侧肢体无力或麻木、口角歪斜、说话不清、剧烈头痛、意识模糊、抽搐',
    '心血管系统': '持续胸痛或胸闷、出冷汗、呼吸困难、心慌伴晕厥',
    '呼吸系统': '呼吸困难加重、嘴唇发紫、咯血、高热不退',
    '消化系统': '呕血、黑便、剧烈腹痛、持续呕吐无法进食',
    '运动系统': '外伤后无法活动、肢体变形、大小便失禁',
    '泌尿系统': '无尿、血尿伴发热、剧烈腰痛伴呕吐',
    '生殖系统': '大量阴道出血、剧烈下腹痛、晕厥',
    '内分泌代谢': '意识模糊、极度口渴伴呕吐、血糖异常无法纠正',
    '精神心理': '出现自伤或伤人念头、严重失眠伴行为异常',
    '皮肤': '皮疹迅速蔓延伴呼吸困难、眼睑或口唇肿胀',
    '眼': '突然视力丧失、眼痛伴头痛呕吐',
    '耳鼻咽喉': '大量鼻出血无法止住、吞咽困难、呼吸困难',
    '全身一般情况': '呼吸困难、意识改变、大量出血、剧烈头痛、突发无力或说话不清'
  };

  function systemWarnings() {
    const list = [...new Set(state.systems.map(s => SYSTEM_WARNINGS[s]).filter(Boolean))];
    const base = list.length ? list.join('；') : SYSTEM_WARNINGS['全身一般情况'];
    return `${base}。出现以上任一情况，请立即拨打 120 或前往急诊。`;
  }

  /* ---------------- 追问推进 ---------------- */
  /* 点选优先：把一道题画到页面上（选项 ≥2 时藏起输入框） */
  function renderOptions(options) {
    const grid = $('optionGrid');
    const form = $('followupForm');
    const list = Array.isArray(options) ? options.filter(Boolean).slice(0, 5) : [];

    if (list.length >= 2) {
      grid.classList.remove('hidden');
      grid.innerHTML = list.map(o =>
        `<button class="opt-btn" type="button" data-opt="${esc(o)}">${esc(o)}</button>`
      ).join('');
      grid.querySelectorAll('[data-opt]').forEach(btn => {
        btn.addEventListener('click', () => submitAnswer(btn.dataset.opt));
      });
      form.classList.add('opts-only');
      $('typeInstead').classList.remove('hidden');
    } else {
      grid.classList.add('hidden');
      grid.innerHTML = '';
      form.classList.remove('opts-only');
      $('typeInstead').classList.add('hidden');
    }
  }

  function applyQuestion(meta) {
    state.meta = meta;
    state.question = meta.question;
    $('followupQuestion').textContent = meta.question;
    $('followupHint').textContent = '点下面的选项就行；都不是，也可以自己写。';
    $('followupProgress').textContent = `第 ${state.history.length + 1} 个问题`;
    $('followupFormHint').textContent = '写完点“发送”，也可以按回车键';
    renderMeter(state.history.length);
    $('followupForm').classList.remove('hidden');
    busyUI(false);
    renderOptions(meta.options);
    renderTranscript();

    if (!meta.options || meta.options.length < 2) {
      $('followupInput').focus({ preventScroll: true });
    }
  }

  function nextQuestion() {
    const askedKeys = new Set(state.history.map(h => h.key).filter(Boolean));
    let meta = null;
    if (!askedKeys.has('red-onset') && !askedKeys.has('red-companion')) meta = redFlagQuestion();
    if (!meta) meta = questionForStep(askedKeys);
    if (!meta) { finishAssessment(); return; }
    applyQuestion(meta);
  }

  /* ================= 大模型：追问与结论 ================= */
  const MAX_AI_ROUNDS = 2;   // 2 轮 × 2–3 问，共 4–6 问，避免听障用户被追问拖太久

  function setAiChip(text, tone, title) {
    const chip = $('aiChip');
    const label = $('aiChipText');
    if (!chip || !label) return;
    label.textContent = text;
    chip.classList.toggle('on', tone === 'on');
    chip.classList.toggle('off', tone !== 'on');
    if (title) chip.title = title;
  }

  function showBanner(text, kind) {
    const box = $('llmBanner');
    if (!box) return;
    $('llmBannerText').textContent = text;
    box.className = 'llm-banner ' + (kind || 'error');
    box.classList.remove('hidden');
  }

  function hideBanner() {
    const box = $('llmBanner');
    if (box) box.classList.add('hidden');
  }

  function aiErrorText(err) {
    const map = {
      NO_CONFIG: '服务端缺少 llm.config.json。',
      BAD_CONFIG: 'llm.config.json 里的 baseURL / model / apiKey 还没填完整。',
      NO_KEY: '模型服务拒绝了这个 Key，可能已失效或填错。',
      RATE_LIMIT: '模型服务限流，稍后再试。',
      TIMEOUT: '模型响应超时。',
      NETWORK: '连不上模型服务，请检查网络与 baseURL。',
      UPSTREAM: '模型服务返回了错误。',
      BAD_SHAPE: '模型返回的格式不符合约定，已丢弃。',
      EMPTY: '模型没有返回内容。'
    };
    const base = map[(err && err.code) || ''] || '调用模型失败。';
    return err && err.message && err.code !== 'UPSTREAM' ? base : base + (err && err.message ? '（' + err.message + '）' : '');
  }

  /* 请求进行中的统一状态 */
  function busyUI(on, text) {
    state.busy = on;
    const wait = $('followupWait');
    if (wait) {
      if (text) wait.querySelector('span').textContent = text;
      wait.classList.toggle('hidden', !on);
    }
    $('followupInput').disabled = on;
    $('followupSubmit').disabled = on;
    document.querySelectorAll('#optionGrid .opt-btn').forEach(b => { b.disabled = on; });
  }

  /* 一轮：让模型给 2–3 个问题，逐条问 */
  async function askNextRound() {
    if (!state.aiMode) { nextQuestion(); return; }
    if (state.aiRound >= MAX_AI_ROUNDS) { finishAssessment(); return; }

    busyUI(true, '正在根据你的描述生成追问…');
    hideBanner();
    state.question = '';          // 等待期间不显示"待答"行，避免看起来卡在上一问
    state.meta = null;
    renderTranscript();

    try {
      const data = await LLM.triageQuestions({
        chief: state.chief,
        history: state.history,
        round: state.aiRound + 1,
        maxRounds: MAX_AI_ROUNDS
      });

      state.aiRound += 1;

      if (data.done || !data.questions.length) {
        busyUI(false);
        finishAssessment();
        return;
      }

      state.aiQueue = data.questions.slice();
      state.target = Math.max(2, Math.min(9, state.history.length + data.questions.length));
      busyUI(false);
      askFromQueue();
    } catch (err) {
      busyUI(false);
      fallbackToLocal(err);
    }
  }

  /* 从当前轮的队列里取下一问 */
  function askFromQueue() {
    const next = state.aiQueue.shift();
    if (!next) { askNextRound(); return; }
    applyQuestion({ key: 'ai', label: next.label, question: next.question, options: next.options });
  }

  /* 模型不可用：切成规则版把剩下的问题问完，绝不空转 */
  function fallbackToLocal(err) {
    console.warn('[MedEcho] 模型不可用，改用规则版：', err);
    state.aiMode = false;
    state.aiQueue = [];
    state.target = MAX_FOLLOWUPS;
    setAiChip('规则版', 'off', '模型不可用，已切换为内置规则');
    showBanner(aiErrorText(err) + '后续追问与结论改用内置规则生成。', 'warn');
    nextQuestion();
  }

  /* 结论：交给模型整理摘要；失败返回 false，由调用方退回规则版 */
  async function runReport() {
    busyUI(true, '正在整理就诊摘要…');
    hideBanner();
    state.question = '';
    state.meta = null;
    renderTranscript();

    try {
      const data = await LLM.triageReport({
        chief: state.chief,
        history: state.history,
        redFlags: redFlagLabels(allText())
      });
      applyReport(data);
      return true;
    } catch (err) {
      console.warn('[MedEcho] 摘要生成失败，改用规则版：', err);
      state.aiMode = false;
      state.aiQueue = [];
      state.target = MAX_FOLLOWUPS;
      setAiChip('规则版', 'off', '模型不可用，已切换为内置规则');
      showBanner(aiErrorText(err) + '结论改用内置规则生成。', 'warn');
      busyUI(false);
      return false;
    }
  }

  /* 把模型给的结论写进结果页 */
  function applyReport(data) {
    state.question = '';
    state.meta = null;
    state.aiQueue = [];
    state.depts = data.depts.length ? data.depts : ['全科医学科'];
    state.systems = data.systems.length ? data.systems : ['全身一般情况'];

    // 安全网：本地规则命中过红旗时，优先级不允许被下调
    state.priority = (state.urgent || data.priority === 'emergency') ? 'emergency' : data.priority;
    state.urgent = state.priority === 'emergency';

    closeFollowup();

    $('summaryText').textContent = data.summary || summaryText();
    const dept = state.depts[0] || '全科医学科';
    $('deptHint').textContent = '';
    $('assessmentSource').textContent = 'AI 分析 · 非诊断';
    updateUrgency();
    renderPossibilities();

    $('bookingAdvice').textContent = data.bookingAdvice || localBookingAdvice(dept);
    $('homeAdvice').textContent = data.homeAdvice || '记录症状出现的时间、频率和诱因；保证休息与饮水，避免熬夜、饮酒和自行加减药物。观察期间若加重，随时改为线下就诊。';
    $('redFlagAdvice').textContent = data.redFlags.length
      ? data.redFlags.join('；') + '。出现以上任一情况，请立即拨打 120 或前往急诊。'
      : systemWarnings();

    rebuildSlots();
    setupHospitalFilter();
    renderAppointments();
    revealResults();
  }

  function closeFollowup() {
    $('followupQuestion').textContent = '信息已经整理好了';
    $('followupHint').textContent = '为你整理的结果在下一页。';
    $('followupProgress').textContent = state.history.length ? `已回答 ${state.history.length} 个问题` : '已整理';
    $('optionGrid').classList.add('hidden');
    $('optionGrid').innerHTML = '';
    $('typeInstead').classList.add('hidden');
    renderMeter(-1);
    $('followupForm').classList.add('hidden');
    busyUI(false);
    renderTranscript();
  }

  function renderPossibilities() {
    const depts = state.depts.length ? state.depts : ['全科医学科'];
    const systems = state.systems.filter(Boolean);
    $('possibilities').innerHTML = depts
      .map((d, i) => `<button type="button" class="dept-chip${i === 0 ? ' main' : ''}" data-dept="${esc(d)}">
        ${esc(d)}<i class="chip-go">看号 →</i>
      </button>`)
      .join('') + (systems.length ? `<div class="dept-note">可能和 ${esc(systems.join('、'))} 有关</div>` : '');

    $('possibilities').querySelectorAll('[data-dept]').forEach(btn => {
      btn.addEventListener('click', () => pickDept(btn.dataset.dept));
    });
  }

  /* 当前生效的科目：用户点了「只看 X」就用 X，否则跟随分诊首选科室。
     机构检索、号源生成、列表与地图只认这一个科目。 */
  function activeDept() {
    return state.deptFilter || state.depts[0] || '全科医学科';
  }

  /* 点科室 → 去「找医院」，只看这个科的号 */
  function pickDept(dept) {
    state.deptFilter = dept;
    go('hospital');
    renderDeptFilter();
    updateFindTag(dept);
    if (state.location) {
      // 科目变了 → 用这个科目的检索范围重新搜一遍（请求的类型码头也跟着换）
      searchNearbyHospitals(true);
    } else {
      renderAppointments();
      $('mapStatus').textContent = `只看「${dept}」的号；先点上面的按钮定位，就能看到附近哪家机构能看这个科。`;
    }
  }

  function renderDeptFilter() {
    const box = $('deptFilterBox');
    if (!box) return;
    if (!state.deptFilter) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = `<span class="dept-filter-chip">只看：<b>${esc(state.deptFilter)}</b>
      <button type="button" id="clearDeptFilter" aria-label="取消科室筛选">×</button></span>`;
    $('clearDeptFilter').addEventListener('click', () => {
      state.deptFilter = '';
      renderDeptFilter();
      updateFindTag(activeDept());
      if (state.location) searchNearbyHospitals(true);
      else renderAppointments();
    });
  }

  /* 右上角「全科 · 附近优先」跟随当前科目，不再是写死的文案 */
  function updateFindTag(dept) {
    const tag = $('findTag');
    if (tag) tag.textContent = `${dept || activeDept()} · 附近优先`;
  }

  function localBookingAdvice(dept) {
    return state.priority === 'emergency'
      ? '请先联系 120 或前往急诊，不要等待门诊号源。'
      : `可先挂${dept}门诊${state.priority === 'observe' ? '（症状持续再去）' : '，尽量约在 3 天内'}。就诊时带上症状时间线、正在服用的药物清单和既往检查结果。`;
  }

  /* 切到第 3 页 */
  function revealResults() {
    $('results').classList.remove('hidden');
    go('result');
  }

  /* ---------------- 结果渲染 ---------------- */
  /* 结论入口：AI 优先，失败自动退回规则版 */
  async function finishAssessment() {
    if (state.aiMode && window.LLM) {
      if (await runReport()) return;
    }
    finishLocal();
  }

  /* 规则版结论（AI 不可用时兜底） */
  function finishLocal() {
    state.question = '';
    state.meta = null;
    state.aiQueue = [];

    // 阶段 3：信息补齐后，按完整描述重新匹配系统与科室（否定描述不参与匹配）
    const triage = matchTriage(positiveText());
    state.depts = triage.depts;
    state.systems = triage.systems;

    closeFollowup();

    $('summaryText').textContent = summaryText();
    updateUrgency();
    const dept = state.depts[0] || '全科医学科';
    $('deptHint').textContent = '';
    $('assessmentSource').textContent = '参考信息 · 非诊断';
    renderPossibilities();
    $('homeAdvice').textContent = '记录症状出现的时间、频率和诱因；保证休息与饮水，避免熬夜、饮酒和自行加减药物。观察期间若加重，随时改为线下就诊。';
    $('bookingAdvice').textContent = localBookingAdvice(dept);
    $('redFlagAdvice').textContent = systemWarnings();

    // 号源只跟随当前已定位的医院，重新梳理不引入其他医院数据
    rebuildSlots();
    setupHospitalFilter();
    renderAppointments();
    revealResults();
  }

  /* ---------------- 号源：严格绑定当前医院 + 当前科目 ---------------- */
  function rebuildSlots() {
    state.slots = [];
    if (!state.hospitals.length) return;
    const dept = activeDept();          // 只生成「当前科目」的号源，不掺别的科

    state.hospitals.forEach(hospital => {
      const doctor = doctorFor(hospital.id, dept);
      const seed = hash(hospital.id + '|' + dept + '|slot');
      state.slots.push({
        id: `${hospital.id}::${dept}`,
        hospitalId: hospital.id,
        hospitalName: hospital.name,
        hospitalAddress: hospital.address || '',
        distance: hospital.distance,
        dept,
        doctor: doctor.name,
        title: doctor.title,
        specialty: doctor.specialty,
        price: doctor.price,
        day: seed % 3,
        time: ['09:00', '14:00', '15:30'][(seed >>> 3) % 3],
        left: 1 + ((seed >>> 7) % 6)
      });
    });
  }

  function setupHospitalFilter() {
    const select = $('hospitalFilter');
    if (!state.hospitals.length) {
      state.hospitalId = 'all';
      select.innerHTML = '<option value="all">全部医院</option>';
      select.disabled = true;
      select.value = 'all';
      return;
    }
    select.disabled = false;
    select.innerHTML = `<option value="all">全部医院（${state.hospitals.length} 家）</option>` +
      state.hospitals.map(h => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join('');
    if (state.hospitalId !== 'all' && !state.hospitals.some(h => h.id === state.hospitalId)) {
      state.hospitalId = 'all';
    }
    select.value = state.hospitalId;
  }

  function currentHospital() {
    return state.hospitals.find(h => h.id === state.hospitalId) || null;
  }

  function dayLabel(offset) {
    if (offset === 0) return '今天';
    if (offset === 1) return '明天';
    return `${offset} 天后`;
  }

  /* 号源卡片：一行一个，信息按"医院 → 科室医生 → 时间/余号/费用"分三层 */
  function rowHtml(item) {
    const tight = item.left <= 2;
    return `<article class="apt-card" data-hospital="${esc(item.hospitalId)}">
      <div class="apt-line1">
        <b class="apt-hosp">${esc(item.hospitalName)}</b>
        <span class="apt-far">${(item.distance / 1000).toFixed(1)} 公里</span>
      </div>
      <div class="apt-line2">${esc(item.dept)} · ${esc(item.doctor)} ${esc(item.title)}</div>
      <div class="apt-line3">
        <span>${dayLabel(item.day)} ${esc(item.time)}</span>
        <span class="${tight ? 'low' : ''}">还剩 ${item.left} 个号</span>
        <span>挂号费 ¥${item.price}</span>
      </div>
      <button class="book-btn" type="button" data-book="${esc(item.id)}">预约这个号</button>
    </article>`;
  }

  function updateStats(items, hospital) {
    const ready = !state.urgent && !!state.location && state.hospitals.length > 0;
    if (!ready) {
      ['statHospitals', 'statSlots', 'statNearest', 'statEarliest'].forEach(id => { $(id).textContent = '—'; });
      return;
    }
    const nearest = items.length ? Math.min(...items.map(i => i.distance)) : 0;
    const earliest = items.slice().sort((a, b) => a.day - b.day || a.time.localeCompare(b.time))[0];
    $('statHospitals').textContent = hospital ? 1 : state.hospitals.length;
    $('statSlots').textContent = items.length;
    $('statNearest').textContent = items.length ? `${(nearest / 1000).toFixed(1)} km` : '—';
    $('statEarliest').textContent = earliest ? `${dayLabel(earliest.day)} ${earliest.time}` : '—';
  }

  function renderAppointments() {
    const maxPrice = Number($('priceFilter').value);
    $('priceOutput').textContent = maxPrice >= 300 ? '不限' : `¥${maxPrice}`;

    const hospital = currentHospital();
    // 唯一来源：state.slots（已由当前定位的医院生成），再按选中医院 / 科室收窄
    const deptF = state.deptFilter;
    const scoped = state.slots.filter(s =>
      (!hospital || s.hospitalId === hospital.id) && (!deptF || s.dept === deptF));
    const items = state.urgent ? [] : scoped.filter(s => s.price <= maxPrice);

    const sort = $('sortSelect').value;
    items.sort((a, b) =>
      sort === 'price-asc' ? a.price - b.price || a.distance - b.distance
        : sort === 'time-asc' ? a.day - b.day || a.time.localeCompare(b.time)
          : a.distance - b.distance || a.price - b.price
    );

    updateStats(items, hospital);

    $('appointmentList').innerHTML = state.urgent
      ? '<div class="empty-results">现在建议先去急诊，这里就不显示普通门诊号了。</div>'
      : !state.location
        ? '<div class="empty-results">先点上面的「定位并查找附近医院」，这里才会出现号。</div>'
        : !state.hospitals.length
          ? `<div class="empty-results">这个范围里没有能看「${esc(activeDept())}」的机构，把“查找范围”改大一点再试。</div>`
          : items.length
            ? items.map(item => rowHtml(item)).join('')
            : deptF
              ? `<div class="empty-results">这里暂时没有「${esc(deptF)}」的号，点上面的「只看：${esc(deptF)} ×」可以取消筛选。</div>`
              : '<div class="empty-results">这个条件下没有号，换个医院或点“清空筛选”。</div>';

    $('appointmentList').querySelectorAll('[data-book]').forEach(button => {
      button.addEventListener('click', () => openBooking(button.dataset.book));
    });
  }

  /* ---------------- 地图与医院选择 ---------------- */
  function renderHospitalLocations() {
    const host = $('mapLocations');
    if (!state.hospitals.length) {
      host.innerHTML = `<div class="empty-results">没有符合条件的机构。</div>`;
      return;
    }
    host.innerHTML = state.hospitals.map(h => `<button type="button" class="map-location ${h.id === state.hospitalId ? 'on' : ''}" data-place="${esc(h.id)}">
      <b>${esc(h.name)}</b>
      <small>${esc(h.address || '高德暂未返回详细地址')} · ${(h.distance / 1000).toFixed(1)} km</small>
    </button>`).join('');
    host.querySelectorAll('[data-place]').forEach(button => {
      button.addEventListener('click', () => selectHospital(button.dataset.place));
    });
  }

  async function renderHospitalMap(dept) {
    if (!state.location || !state.hospitals.length) return;
    const scope = dept || activeDept();
    const places = state.hospitals.map(h => ({
      id: h.id, name: h.name, coord: h.coord, addr: h.address
    }));
    const realPoi = state.hospitals.some(h => String(h.id).indexOf('amap-') === 0);
    const placeText = state.location.live ? '实时定位'
      : (state.location.demo ? '演示位置（未获取设备定位）' : '定位');
    $('mapStatus').textContent = `${placeText} · ${realPoi ? '高德地图' : '内置演示数据'} · ${state.location.address} · ${state.radius / 1000} km 内 ${places.length} 家能看「${scope}」的机构`;
    const mode = await MAP.render($('hospitalMap'), {
      places,
      home: { name: '当前位置', coord: state.location.coord, xy: [152, 152] },
      selected: state.hospitalId,
      actualLocation: true,
      live: !!state.location.live,
      accuracy: state.location.accuracy,
      onPick(id) { selectHospital(id); }
    });
    if (mode === 'error') $('mapStatus').textContent = '地图加载失败；下方医院列表仍可选择。';
  }

  // 唯一选择入口：筛选下拉、地图标记、医院列表、地图选点都走这里
  function selectHospital(id) {
    const valid = id === 'all' || state.hospitals.some(h => h.id === id);
    state.hospitalId = valid ? id : 'all';
    $('hospitalFilter').value = state.hospitalId;
    renderAppointments();
    renderHospitalLocations();
    if (window.MAP) MAP.select(state.hospitalId);
  }

  async function searchNearbyHospitals(reuseLocation) {
    const button = $('locateMe');
    if (!button.dataset.idleHtml) button.dataset.idleHtml = button.innerHTML;   // 留住图标，结束时还原
    const dept = activeDept();
    button.disabled = true;
    button.textContent = reuseLocation ? '正在筛选…' : '正在定位…';
    if (!reuseLocation) $('mapStatus').textContent = '正在获取位置…';

    try {
      if (!reuseLocation || !state.location) {
        state.location = await MAP.locateCurrent();
        updateLocationChip();
        $('locationStatus').textContent = `${state.location.city} · 正在搜索`;
      }
      $('mapStatus').textContent = state.location.live
        ? `已获取实时定位，正在搜索能看「${dept}」的机构…`
        : `已定位到${state.location.city}，正在搜索能看「${dept}」的机构…`;
      button.textContent = '正在搜索…';

      state.radius = Number($('poiRadius').value);
      // 科目作为参数进入检索：请求的类型码 + 结果闸门都由它决定
      const found = await MAP.searchNearbyHospitals(state.location.coord, state.radius, dept);

      // 只保留最近的若干家，列表、筛选、号源使用同一份数据
      state.hospitals = found.slice(0, MAX_HOSPITALS);
      state.hospitalId = 'all';
      updateLocationChip();
      updateFindTag(dept);
      rebuildSlots();
      setupHospitalFilter();
      renderAppointments();
      await renderHospitalPanel(dept);
    } catch (error) {
      state.hospitals = [];
      state.slots = [];
      state.hospitalId = 'all';
      setupHospitalFilter();
      renderAppointments();
      $('mapLocations').innerHTML = '';
      $('hospitalMap').innerHTML = `<div class="empty-results">${esc(error.message || '暂时无法显示附近机构，请检查 Key、网络和定位权限后重试。')}</div>`;
      $('mapStatus').textContent = error.message || '定位或机构搜索失败。';
      $('locationStatus').textContent = '定位失败，号源不可用';
      updateLocationChip();
    } finally {
      button.disabled = false;
      button.innerHTML = button.dataset.idleHtml || '重新定位并搜索';
    }
  }

  /* 机构面板：空态 / 列表 / 地图，只画当前科目范围内的结果 */
  async function renderHospitalPanel(dept) {
    if (!state.hospitals.length) {
      $('hospitalMap').innerHTML =
        `<div class="empty-results">${state.radius / 1000} km 内没有能看「${esc(dept)}」的机构，把“查找范围”调大一点再试。</div>`;
      $('mapLocations').innerHTML = `<div class="empty-results">这个范围里没有匹配「${esc(dept)}」的机构。</div>`;
      $('mapStatus').textContent = `已定位到${state.location.city}，但这个范围里没有能看「${dept}」的机构。`;
      $('locationStatus').textContent = `${state.location.city} · ${dept} · 范围内无机构`;
      return;
    }
    $('locationStatus').textContent =
      `${state.location.city} · ${dept} · ${state.radius / 1000} km · ${state.hospitals.length} 家`;
    renderHospitalLocations();
    await renderHospitalMap(dept);
  }

  function updateLocationChip() {
    const chip = $('locationChip');
    const text = $('locationChipText');
    if (state.location && state.hospitals.length) {
      chip.classList.add('on');
      text.textContent = state.location.live ? '已定位 · 实时' : `已定位 · ${state.location.city}`;
    } else if (state.location) {
      chip.classList.remove('on');
      text.textContent = '已定位 · 附近无医院';
    } else {
      chip.classList.remove('on');
      text.textContent = '未定位';
    }
  }

  /* ---------------- 预约核对 ---------------- */
  function openBooking(id) {
    const item = state.slots.find(s => s.id === id);
    if (!item) return;   // 号源已失效则不再展示
    state.chosenSlotId = item.id;
    state.record = null;  // 换了号源，档案重新生成
    const row = (label, value) => `<div class="detail-row"><span>${label}</span><b>${esc(value)}</b></div>`;
    $('dialogTitle').textContent = '核对预约信息';
    $('bookingDetails').innerHTML =
      row('医院', item.hospitalName) +
      row('科室', item.dept) +
      row('医生', `${item.doctor} · ${item.title}`) +
      row('时间', `${dayLabel(item.day)} ${item.time}`) +
      row('挂号费', `¥${item.price}`) +
      row('距离', `${(item.distance / 1000).toFixed(1)} km`) +
      row('号源来源', `当前定位 ${state.radius / 1000} km 内医院`);
    $('bookingDialog').showModal();
  }

  /* ================= 就诊档案：提问卡 + 医生回答 + 医嘱卡 ================= */
  const RIDE = ['booked', 'waiting', 'seeing', 'pharmacy', 'done'];
  const RIDE_TEXT = { booked: '已挂号', waiting: '候诊中', seeing: '问诊中', pharmacy: '取药', done: '完成' };

  /* 演示模板：不同系统给不同的"该问医生的问题 + 医生会怎么答 + 医嘱" */
  const RECORD_TPL = {
    '消化系统': {
      dept: '消化内科',
      qa: [
        ['需要做胃镜吗？', '建议做一次胃镜看看，安排在明天上午，今晚 10 点以后不要吃东西。'],
        ['这些药要吃多久？', '先吃两周，症状好了也别马上停，复诊时我再看要不要调整。'],
        ['饮食上要注意什么？', '少食多餐，别吃辣、别喝浓茶咖啡，吃完饭别马上躺下。']
      ],
      med: '奥美拉唑肠溶胶囊 20mg，每天 2 次，饭前半小时',
      diet: '少食多餐，忌辛辣、浓茶、咖啡，饭后 1 小时内不要平躺',
      revisit: '2 周后 · 消化内科复诊'
    },
    '神经系统': {
      dept: '神经内科',
      qa: [
        ['需要做头部 CT 吗？', '先做一次头颅 CT 排除出血，结果出来再看要不要加做磁共振。'],
        ['这个药要一直吃吗？', '先吃一个月，期间记录发作次数，复诊时按情况减量。'],
        ['平时要注意什么？', '别熬夜、别突然起身，发作时坐下或躺下，避免摔倒。']
      ],
      med: '氟桂利嗪胶囊 5mg，每晚 1 次，睡前服',
      diet: '规律作息，避免熬夜和空腹，少喝浓茶咖啡',
      revisit: '1 个月后 · 神经内科复诊'
    },
    '呼吸系统': {
      dept: '呼吸内科',
      qa: [
        ['需要拍胸片吗？', '先拍个胸片，看看有没有炎症，明天上午就能出结果。'],
        ['咳嗽药吃哪种？', '先吃化痰的，别自己加抗生素，痰变黄变浓再来找我。'],
        ['多久能好？', '一般一到两周，抽烟的话这段时间一定别抽。']
      ],
      med: '氨溴索口服溶液 10ml，每天 3 次，饭后服',
      diet: '多喝温水，忌烟酒和辛辣，注意保暖',
      revisit: '1 周后 · 呼吸内科复诊'
    },
    '运动系统': {
      dept: '骨科',
      qa: [
        ['需要拍片子吗？', '先拍个腰椎正侧位片，看看有没有骨质问题。'],
        ['能按摩或者拔罐吗？', '这段时间先别做，等片子结果出来再说。'],
        ['平时怎么养？', '别久坐久弯腰，睡觉用硬一点的床，注意腰部保暖。']
      ],
      med: '塞来昔布胶囊 200mg，每天 1 次，饭后服',
      diet: '避免负重和久坐，注意腰部保暖',
      revisit: '2 周后 · 骨科复诊'
    },
    'default': {
      dept: '全科医学科',
      qa: [
        ['需要做哪些检查？', '先抽血和做个基础检查，明天上午空腹来。'],
        ['这些药怎么吃？', '按药盒上写的吃，别自己加量，吃完再复诊。'],
        ['什么时候再来？', '两周后回来复诊，期间不舒服随时来。']
      ],
      med: '按处方取药，遵医嘱服用',
      diet: '规律作息，清淡饮食，避免劳累',
      revisit: '2 周后 · 全科医学科复诊'
    }
  };

  const RECITE = [
    { q: '这个药一天吃几次？', opts: ['1 次', '2 次', '3 次'], right: 1 },
    { q: '饭前吃还是饭后吃？', opts: ['饭前', '饭后', '都可以'], right: 0 },
    { q: '什么时候来复诊？', opts: ['1 周后', '2 周后', '1 个月后'], right: 1 }
  ];

  function buildRecord() {
    const system = state.systems[0] || '全身一般情况';
    const tpl = RECORD_TPL[system] || RECORD_TPL['default'];
    const slot = state.slots.find(s => s.id === state.chosenSlotId) || null;
    const dept = state.depts[0] || tpl.dept;

    state.record = {
      system,
      dept,
      hospital: slot ? slot.hospitalName : '演示医院（尚未定位）',
      doctor: slot ? `${slot.doctor} ${slot.title}` : '演示医生',
      when: slot ? `${dayLabel(slot.day)} ${slot.time}` : '待定',
      ride: 'booked',
      qa: tpl.qa,
      orders: [
        { k: '诊断', v: `${dept}相关情况（需医生面诊确认）` },
        { k: '用药', v: tpl.med },
        { k: '复诊', v: tpl.revisit },
        { k: '饮食', v: tpl.diet },
        { k: '立即急诊', v: '呕血、黑便、剧烈腹痛不止、意识不清', danger: true }
      ],
      recite: RECITE.map(x => ({ q: x.q, opts: x.opts, right: x.right, done: false, wrong: -1 })),
      reciteDone: false
    };
  }

  function openRecord() {
    if (!state.record) buildRecord();
    renderRecord();
    go('record');
  }

  function renderRecord() {
    const r = state.record;
    if (!r) return;

    const idx = RIDE.indexOf(r.ride);
    $('rideSteps').querySelectorAll('li').forEach((li, i) => {
      li.classList.toggle('done', i < idx);
      li.classList.toggle('on', i === idx);
      li.querySelector('i').textContent = i < idx ? '✓' : String(i + 1);
    });
    $('rideHint').textContent = state.shareMode
      ? '现在：' + RIDE_TEXT[r.ride] + ' · 家属可以同步看到进度'
      : '现在：' + RIDE_TEXT[r.ride] +
        (idx < RIDE.length - 1 ? ' · 演示可以点“下一步”推进' : ' · 全部完成，记得按医嘱吃药');

    $('recMeta').textContent = `${r.hospital} · ${r.dept} · ${r.doctor} · ${r.when}`;

    // 我想问的
    $('questionList').innerHTML = r.qa.map(([qu], i) =>
      `<li><span class="who">问 ${i + 1}</span>${esc(qu)}</li>`
    ).join('') + '<li class="pending">还想问别的？写在纸上，或者直接问医生。</li>';

    // 医生说的（问诊开始后才出现）
    const seen = idx >= RIDE.indexOf('seeing');
    $('doctorEmpty').classList.toggle('hidden', seen);
    $('doctorList').innerHTML = seen ? r.qa.map(([qu, an], i) =>
      `<li><span class="who">答 ${i + 1}</span><b>${esc(qu)}</b><br />${esc(an)}</li>`
    ).join('') : '';

    renderOrders();

    // 取药核对
    const showRecite = idx >= RIDE.indexOf('pharmacy');
    $('reciteCard').classList.toggle('hidden', !showRecite);
    if (showRecite) renderRecite();

    // 推进按钮文案
    const btn = $('advanceState');
    btn.disabled = idx >= RIDE.length - 1;
    btn.textContent = idx >= RIDE.length - 1 ? '流程已完成' : '下一步：' + RIDE_TEXT[RIDE[idx + 1]];

    document.body.classList.toggle('share-mode', !!state.shareMode);
    $('shareBar').classList.toggle('hidden', !state.shareMode);
  }

  function renderOrders() {
    const r = state.record;
    $('orderList').innerHTML = r.orders.map((o, i) => `
      <li class="order-item${o.ok ? ' confirmed' : ''}${o.danger ? ' danger' : ''}">
        <span class="k">${esc(o.k)}</span>
        <span class="v">${esc(o.v)}</span>
        <button class="ok-btn" type="button" data-ok="${i}">${o.ok ? '已确认 ✓' : '确认'}</button>
      </li>`).join('');
    $('orderList').querySelectorAll('[data-ok]').forEach(b => {
      b.addEventListener('click', () => {
        const i = Number(b.dataset.ok);
        if (r.orders[i].ok) return;
        r.orders[i].ok = true;
        renderOrders();
      });
    });
    const left = r.orders.filter(o => !o.ok).length;
    $('confirmLeft').textContent = left;
  }

  function renderRecite() {
    const r = state.record;
    $('reciteBody').innerHTML = r.recite.map((item, qi) => `
      <div class="recite-q">
        <b>${qi + 1}. ${esc(item.q)}</b>
        <div class="recite-opts">
          ${item.opts.map((o, oi) => {
            let cls = '';
            if (item.done && oi === item.right) cls = ' right';
            else if (item.wrong === oi) cls = ' wrong';
            return `<button type="button" class="${cls}" data-q="${qi}" data-o="${oi}">${esc(o)}</button>`;
          }).join('')}
        </div>
      </div>`).join('') + '<p class="recite-tip hidden" id="reciteTip">再看一眼上面的医嘱卡，选错了。</p>';

    $('reciteBody').querySelectorAll('button[data-q]').forEach(btn => {
      btn.addEventListener('click', () => {
        const qi = Number(btn.dataset.q);
        const oi = Number(btn.dataset.o);
        const item = r.recite[qi];
        if (item.done) return;
        if (oi === item.right) {
          item.done = true;
          item.wrong = -1;
        } else {
          item.wrong = oi;
        }
        renderRecite();
        checkRecite();
      });
    });

    $('reciteDone').classList.toggle('hidden', !r.reciteDone);
  }

  function checkRecite() {
    const r = state.record;
    const tip = $('reciteTip');
    const allDone = r.recite.every(x => x.done);
    const hasWrong = r.recite.some(x => x.wrong >= 0);
    if (tip) tip.classList.toggle('hidden', !hasWrong || allDone);
    if (allDone && !r.reciteDone) {
      r.reciteDone = true;
      $('reciteDone').classList.remove('hidden');
    }
  }

  function advanceRide() {
    const r = state.record;
    if (!r) return;
    const i = RIDE.indexOf(r.ride);
    if (i >= RIDE.length - 1) return;
    r.ride = RIDE[i + 1];
    renderRecord();
    if (r.ride === 'pharmacy') {
      $('reciteCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /* ---------------- 事件 ---------------- */
  $('symptomForm').addEventListener('submit', async event => {
    event.preventDefault();
    const chief = $('symptomInput').value.trim();
    if (!chief) { $('symptomInput').focus(); return; }

    state.chief = chief;
    state.history = [];
    state.step = 0;
    state.meta = null;
    state.question = '';
    state.urgent = detectUrgency(chief);


    $('followupPanel').classList.remove('hidden');
    $('results').classList.add('hidden');
    renderTranscript();
    go('ask');                 // 切到第 2 页

    // 等模型状态探测完成，避免用户手快时误走规则版
    busyUI(true, '正在准备问题…');
    try { await modelReady; } catch (e) {}
    busyUI(false);

    state.aiMode = !!(window.LLM && state.aiReady);
    state.aiRound = 0;
    state.aiQueue = [];
    state.target = state.aiMode ? 6 : MAX_FOLLOWUPS;
    state.deptFilter = '';      // 新的一次梳理，科室筛选回到不限
    hideBanner();

    // 阶段 1：本地红旗规则命中 → 跳过追问，直接出结果并置顶急诊
    if (state.urgent) finishAssessment();
    else if (state.aiMode) askNextRound();
    else nextQuestion();
  });

  $('followupInput').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    $('followupForm').requestSubmit();
  });

  $('followupForm').addEventListener('submit', event => {
    event.preventDefault();
    if (!state.question || state.busy) return;
    const answer = $('followupInput').value.trim();
    if (!answer) return;
    submitAnswer(answer);
  });

  /* 唯一作答入口：点选项和打字都走这里 */
  function submitAnswer(answer) {
    if (!state.question || state.busy || !answer) return;

    const meta = state.meta || { key: '', label: '追问', question: state.question };
    state.history.push({
      key: meta.key,
      label: meta.label,
      question: meta.question,
      answer
    });
    state.step = state.history.length;
    $('followupInput').value = '';
    if (detectUrgency(answer)) state.urgent = true;

    // 红旗优先：不管什么模式，命中就立刻出结论
    if (state.urgent) { finishAssessment(); return; }

    if (state.aiMode) {
      if (state.aiQueue.length) askFromQueue();
      else askNextRound();
      return;
    }

    if (state.history.length >= MAX_FOLLOWUPS) finishAssessment();
    else nextQuestion();
  }

  /* "都不是，我自己写" */
  $('typeInstead').addEventListener('click', () => {
    $('optionGrid').classList.add('hidden');
    $('optionGrid').innerHTML = '';
    $('followupForm').classList.remove('opts-only');
    $('typeInstead').classList.add('hidden');
    $('followupInput').focus({ preventScroll: true });
  });

  /* 首页快捷点选：不会打字也能开始 */
  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $('symptomInput');
      input.value = btn.dataset.fill || '';
      $('charCount').textContent = `${input.value.length} / 600`;
      input.focus({ preventScroll: true });
    });
  });

  $('symptomInput').addEventListener('input', () => {
    $('charCount').textContent = `${$('symptomInput').value.length} / 600`;
  });

  $('hospitalFilter').addEventListener('change', () => selectHospital($('hospitalFilter').value));
  $('sortSelect').addEventListener('change', renderAppointments);
  $('priceFilter').addEventListener('input', renderAppointments);
  $('locateMe').addEventListener('click', () => searchNearbyHospitals(false));
  // 改查找范围只需按新半径重搜，不必再走一次设备定位
  $('poiRadius').addEventListener('change', () => { if (state.location) searchNearbyHospitals(true); });

  $('clearFilters').addEventListener('click', () => {
    $('priceFilter').value = '300';
    $('sortSelect').value = 'distance-asc';
    selectHospital('all');
  });

  $('editSymptoms').addEventListener('click', () => {
    go('start');
    $('symptomInput').focus({ preventScroll: true });
  });

  $('goEdit').addEventListener('click', () => {
    go('start');
    $('symptomInput').focus({ preventScroll: true });
  });

  $('goHospital').addEventListener('click', () => go('hospital'));

  /* 「挑方便的时间去」也是按钮：直接带去挂号 */
  $('urgencyAction').addEventListener('click', () => go('hospital'));
  $('goBack').addEventListener('click', () => go('result'));

  /* ---------------- 就诊档案事件 ---------------- */
  $('goRecord').addEventListener('click', openRecord);
  $('backToResult').addEventListener('click', () => go('result'));
  $('advanceState').addEventListener('click', advanceRide);
  $('printCard').addEventListener('click', () => window.print());

  $('shareCard').addEventListener('click', async () => {
    const url = location.origin + location.pathname + '?share=1';
    const btn = $('shareCard');
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = '链接已复制，发给家属';
    } catch (e) {
      btn.textContent = url;
    }
    setTimeout(() => { btn.textContent = '发给家属'; }, 5000);
  });

  $('resetBtn').addEventListener('click', () => {
    $('symptomForm').reset();
    $('charCount').textContent = '0 / 600';
    $('followupPanel').classList.add('hidden');
    $('results').classList.add('hidden');

    state.chief = '';
    state.question = '';
    state.meta = null;
    state.step = 0;
    state.history = [];
    state.systems = [];
    state.priority = 'routine';
    state.urgent = false;
    state.location = null;
    state.hospitals = [];
    state.hospitalId = 'all';
    state.deptFilter = '';
    state.slots = [];
    state.aiRound = 0;
    state.aiQueue = [];
    state.aiMode = false;
    state.busy = false;
    state.target = MAX_FOLLOWUPS;
    state.record = null;
    state.chosenSlotId = '';
    state.shareMode = false;
    $('results').classList.remove('is-emergency');
    document.body.classList.remove('share-mode');
    $('shareBar').classList.add('hidden');
    $('optionGrid').classList.add('hidden');
    $('optionGrid').innerHTML = '';

    hideBanner();
    busyUI(false);
    $('followupFormHint').textContent = '回答仅用于生成摘要';

    setupHospitalFilter();
    updateLocationChip();
    $('locationStatus').textContent = '请先定位';
    $('mapStatus').textContent = '还没有定位，需要允许浏览器使用位置。';
    $('hospitalMap').innerHTML = '<div class="empty-results">点上面的按钮，就能看到附近的医院。</div>';
    $('mapLocations').innerHTML = '';
    $('locateMe').textContent = '定位并查找附近医院';
    $('priceFilter').value = '300';
    $('priceOutput').textContent = '不限';
    $('sortSelect').value = 'distance-asc';
    if (window.MAP) MAP.reset();
    go('start');
    $('symptomInput').focus({ preventScroll: true });
  });

  $('dialogClose').addEventListener('click', () => $('bookingDialog').close());
  $('dialogDone').addEventListener('click', () => {
    $('bookingDialog').close();
    openRecord();
  });
  $('bookingDialog').addEventListener('click', event => {
    if (event.target === $('bookingDialog')) $('bookingDialog').close();
  });

  /* ---------------- 模型状态与错误处理 ---------------- */
  async function initModel() {
    if (!window.LLM) { setAiChip('规则版', 'off', '未加载大模型客户端'); return; }
    setAiChip('检测模型…', 'off');
    const s = await LLM.status();
    state.aiReady = !!s.ready;
    state.aiModel = s.model || '';
    if (state.aiReady) {
      setAiChip('模型已就绪', 'on', (s.model || '') + (s.endpoint ? '  @ ' + s.endpoint : ''));
    } else if (s.error === 'BAD_CONFIG' || s.error === 'NO_CONFIG') {
      setAiChip('未接入模型', 'off', 'llm.config.json 尚未配置完整');
    } else {
      setAiChip('规则版', 'off', '模型不可用，使用内置规则');
    }
  }

  $('llmRetry').addEventListener('click', () => {
    hideBanner();
    if (!state.aiReady) {
      showBanner('模型仍未就绪，请检查 llm.config.json 后刷新页面。', 'error');
      return;
    }
    state.aiMode = true;
    setAiChip('模型已就绪', 'on', state.aiModel);
    if (state.question) askNextRound();
    else if (state.history.length) finishAssessment();
  });

  $('llmFallback').addEventListener('click', () => {
    hideBanner();
    state.aiMode = false;
    state.aiQueue = [];
    state.target = MAX_FOLLOWUPS;
    setAiChip('规则版', 'off', '已切换为内置规则');
    if (state.question) return;                 // 当前这一问继续答完
    if (state.history.length) nextQuestion();
  });

  setupHospitalFilter();
  modelReady = initModel();
  go('start');
  $('symptomInput').focus({ preventScroll: true });

  /* 家属只读视图：?share=1 直接打开同一张档案，隐藏所有操作 */
  if (new URLSearchParams(location.search).get('share') === '1') {
    state.shareMode = true;
    document.body.classList.add('share-mode');
    $('shareBar').classList.remove('hidden');
    openRecord();
  }
})();
