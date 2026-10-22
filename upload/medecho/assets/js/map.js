/* =========================================================
   同频 MedEcho · 地图模块
   ---------------------------------------------------------
   三个层次，逐级降级，任何一层可用就往前一步：
   1) 高德 JS API 2.0 可用 → 真实地图（底图 + 真实 POI）
   2) 高德不可用（Key 白名单 / 断网 / 无权限）→ 本地演示地图
      用内置医院坐标 + 真实距离算法渲染，交互与真实地图完全一致
   3) 连坐标都没有 → 空态提示

   关键：第 2 层不是「占位图」，它带真实坐标投影、距离环、
   标注避让和选点联动，演示时看起来仍是一张可用的地图。
   ========================================================= */

window.MAP = (function () {

  let sdkPromise = null;
  let amap = null;
  let viewState = null;
  let forceLocal = (window.location && window.location.protocol === 'file:');
  let lastEl = null;
  let lastOpts = null;
  let lastMode = '';
  let lastGeoError = 0;
  let lastHome = null;                 // 上一次渲染用的定位点，用于判断「是否需要丢弃旧视野」
  let resetView = false;               // 本次渲染是否要丢弃旧视野

  function conf() { return window.APP_CONFIG || {}; }
  /* 高德把「没有的字段」返回成空数组 []，空数组是 truthy，
     直接用 a || b 会把真实值吞掉，所以要显式判断字符串 */
  function pickStr(value) {
    return (typeof value === 'string' && value.trim()) ? value.trim() : '';
  }
  function isFilePreview() { return !!(window.location && window.location.protocol === 'file:'); }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function hasKey() {
    const c = conf();
    return !!(c.amapKey && c.useAmap !== false);
  }

  function unavailableReason() {
    if (!hasKey()) return '未配置高德 Web 端 JS API Key，当前使用本地演示地图。';
    if (isFilePreview()) return '当前是 file:// 离线预览，已使用本地演示地图。';
    return '高德地图不可用，已使用本地演示地图。';
  }

  /* 内置演示位置与医疗机构：坐标真实，距离由坐标实时计算 */
  const DEMO = {
    city: '上海市徐汇区',
    address: '上海市徐汇区',
    coord: [121.4375, 31.1885],
    hospitals: [
      { name: '复旦大学附属中山医院', address: '枫林路 180 号', coord: [121.4472, 31.1917] },
      { name: '上海市第六人民医院', address: '宜山路 600 号', coord: [121.4243, 31.1907] },
      { name: '上海中医药大学附属龙华医院', address: '宛平南路 725 号', coord: [121.4425, 31.1740] },
      { name: '复旦大学附属肿瘤医院', address: '东安路 270 号', coord: [121.4570, 31.1930] },
      { name: '上海市胸科医院', address: '淮海西路 241 号', coord: [121.4290, 31.2010] },
      { name: '复旦大学附属华山医院', address: '乌鲁木齐中路 12 号', coord: [121.4463, 31.2130] },
      { name: '上海市第八人民医院', address: '漕宝路 8 号', coord: [121.4280, 31.1740] },
      { name: '复旦大学附属眼耳鼻喉科医院', address: '汾阳路 83 号', coord: [121.4490, 31.2110] },
      { name: '上海交通大学医学院附属瑞金医院', address: '瑞金二路 197 号', coord: [121.4650, 31.2130] },
      { name: '上海市徐汇区中心医院', address: '淮海中路 966 号', coord: [121.4520, 31.2160] }
    ]
  };

  function demoLocation() {
    return { coord: DEMO.coord.slice(), city: DEMO.city, address: DEMO.address, demo: true };
  }

  function distanceMeters(a, b) {
    const R = 6371000;
    const rad = d => d * Math.PI / 180;
    const dLat = rad(b[1] - a[1]);
    const dLng = rad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
  }

  /* ---------------------------------------------------------
     坐标系换算：WGS-84 → GCJ-02

     浏览器 navigator.geolocation 给的是 WGS-84（GPS 原始坐标），
     而高德底图、逆地理编码、周边搜索用的都是 GCJ-02（国测局坐标）。
     这两套坐标在国内相差 300～600 米：直接把设备坐标交给高德，
     「当前位置」会整体偏到隔壁街区，周边医院的距离和排序也跟着错。

     所以换算只做一次，放在拿到设备坐标的第一时间，
     之后标点、逆地理、周边搜索、距离计算全部统一在 GCJ-02 下。
     --------------------------------------------------------- */
  const GCJ_A = 6378245.0;
  const GCJ_EE = 0.00669342162296594323;

  function outOfChina(lng, lat) {
    return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
  }

  function gcjLatOffset(x, y) {
    let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
    r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
    return r;
  }

  function gcjLngOffset(x, y) {
    let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
    r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
    return r;
  }

  function wgs84ToGcj02(lng, lat) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return [lng, lat];
    if (outOfChina(lng, lat)) return [lng, lat];    // 境外两套坐标一致，不做偏移
    let dLat = gcjLatOffset(lng - 105, lat - 35);
    let dLng = gcjLngOffset(lng - 105, lat - 35);
    const radLat = lat / 180 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - GCJ_EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [lng + dLng, lat + dLat];
  }

  function demoHospitals(center, radius) {
    const c = (center && center.length === 2) ? center : DEMO.coord;
    // 人在演示城市附近 → 直接用这几家医院的真实坐标；
    // 人在别处 → 把同一批点位按「相同的相对方位与距离」平移过来，
    // 这样地图上的距离、方位仍然自洽，不会出现 1000 km 这种荒谬结果。
    const onSite = distanceMeters(c, DEMO.coord) <= 5000;
    return DEMO.hospitals.map((h, i) => {
      const coord = onSite
        ? h.coord.slice()
        : [
            Number((c[0] + (h.coord[0] - DEMO.coord[0])).toFixed(6)),
            Number((c[1] + (h.coord[1] - DEMO.coord[1])).toFixed(6))
          ];
      return {
        id: 'demo-' + (i + 1),
        name: h.name,
        address: onSite ? h.address : '演示数据',
        coord,
        distance: distanceMeters(c, coord),
        demoData: true
      };
    }).filter(p => p.distance <= radius).sort((a, b) => a.distance - b.distance);
  }

  /* 高德用 JSON 报文回报错误（HTTP 仍是 200），这里翻成人话 */
  const AMAP_ERRORS = {
    10001: '高德 Key 无效或已被删除（INVALID_USER_KEY）。',
    10003: '高德 Key 已过期（INVALID_USER_KEY）。',
    10006: '高德 Key 的「域名白名单」不含当前访问地址（INVALID_USER_DOMAIN）。',
    10009: '这个 Key 不是「Web 端 (JS API)」类型（USERKEY_PLAT_NOMATCH）。',
    10011: '高德 Key 已被停用（USERKEY_DRIVER_DISABLED）。',
    10044: '该 Key 今日调用量已超限（USER_DAILY_QUERY_OVER_LIMIT）。',
    10045: '该 Key 的并发量超限（USER_QPS_OVER_LIMIT）。'
  };

  let amapErrorText = '';

  /* 先探一次 Key 是否放行：返回 JSON 说明被拒，直接走本地地图，避免控制台报错与 6 秒等待 */
  let probePromise = null;
  function probeAmap() {
    if (probePromise) return probePromise;
    if (!hasKey() || isFilePreview()) { probePromise = Promise.resolve(false); return probePromise; }
    if (window.AMap) { probePromise = Promise.resolve(true); return probePromise; }
    probePromise = (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2800);
        const res = await fetch('https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(conf().amapKey), {
          mode: 'cors', cache: 'no-store', signal: ctrl.signal
        });
        clearTimeout(timer);
        const text = await res.text();
        if (/^\s*\{/.test(text)) {
          amapErrorText = text.slice(0, 400);
          return false;
        }
        return !!res.ok;
      } catch (e) { return false; }
    })();
    return probePromise;
  }

  async function diagnose() {
    if (!amapErrorText) {
      try {
        const res = await fetch('https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(conf().amapKey), { mode: 'cors' });
        amapErrorText = (await res.text()).slice(0, 400);
      } catch (e) {}
    }
    try {
      const data = JSON.parse(amapErrorText);
      return AMAP_ERRORS[Number(data.infocode)] ||
        '高德拒绝了这次请求（' + (data.info || '未知错误') + '，错误码 ' + (data.infocode || '-') + '）。';
    } catch (e) {}
    return '高德地图脚本没有加载成功，已使用本地演示地图。';
  }

  function loadSDK() {
    if (sdkPromise) return sdkPromise;
    const c = conf();
    sdkPromise = new Promise((resolve, reject) => {
      if (window.AMap) return resolve();
      if (c.amapSecurityCode) window._AMapSecurityConfig = { securityJsCode: c.amapSecurityCode };
      const s = document.createElement('script');
      s.async = true;
      s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(c.amapKey) +
        '&plugin=AMap.Walking,AMap.Scale,AMap.ToolBar,AMap.PlaceSearch,AMap.Geolocation';

      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sdkPromise = null;                    // 允许下次真正重试，而不是复读旧错误
        diagnose().then(msg => reject(new Error(msg)));
      };
      const timer = setTimeout(fail, 6000);

      s.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (window.AMap) resolve();
        else { sdkPromise = null; reject(new Error('高德脚本已下载，但地图对象没有初始化。')); }
      };
      s.onerror = fail;
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

  /* ---------------- 主入口 ---------------- */
  async function render(el, opts) {
    if (!el) return 'schematic';

    // 定位点变了就丢弃上一次的视野：否则「重新定位」后地图还停在旧地点，
    // 新的「当前位置」标点落在画布外，看起来像没定位成功。
    // 只切选中项（MAP.select）时定位点不变，仍保留用户手动拖动后的视野。
    const homeCoord = opts && opts.home && opts.home.coord;
    if (homeCoord && homeCoord.length === 2) {
      if (lastHome && (Math.abs(homeCoord[0] - lastHome[0]) > 1e-6 ||
                       Math.abs(homeCoord[1] - lastHome[1]) > 1e-6)) {
        resetView = true;
      }
      lastHome = [homeCoord[0], homeCoord[1]];
    }

    lastEl = el;
    lastOpts = opts;

    const usable = hasKey() && !forceLocal && await probeAmap();
    if (usable) {
      try {
        await loadSDK();
        renderAMap(el, opts);
        lastMode = 'amap';
        return 'amap';
      } catch (e) {
        renderSchematic(el, opts, '高德地图暂时不可用，已切换为本地演示地图');
        lastMode = 'schematic';
        return 'fallback';
      }
    }

    renderSchematic(el, opts, '本地演示地图 · 坐标为演示数据，距离按坐标计算');
    lastMode = 'schematic';
    return 'schematic';
  }

  /* 只切换高亮，不重新定位：地图、列表、筛选共用同一个选中态 */
  function select(id) {
    if (!lastEl || !lastOpts || (lastMode !== 'amap' && lastMode !== 'schematic')) return;
    lastOpts = Object.assign({}, lastOpts, { selected: id });
    if (lastMode === 'amap') renderAMap(lastEl, lastOpts);
    else renderSchematic(lastEl, lastOpts, '本地演示地图 · 坐标为演示数据，距离按坐标计算');
  }

  /* ---------------------------------------------------------
     浏览器原生定位（HTML5 Geolocation）
     这才是真正的「实时定位」：不依赖任何 Key、不依赖高德，
     只要页面在 localhost 或 https 下就能拿到设备真实坐标。
     --------------------------------------------------------- */
  function browserLocate() {
    return new Promise(resolve => {
      if (!navigator.geolocation || !navigator.geolocation.getCurrentPosition) return resolve(null);
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      const timer = setTimeout(() => finish(null), 14000);

      navigator.geolocation.getCurrentPosition(
        pos => {
          clearTimeout(timer);
          const c = pos.coords || {};
          const lng = Number(c.longitude);
          const lat = Number(c.latitude);
          if (!Number.isFinite(lng) || !Number.isFinite(lat)) return finish(null);
          const acc = Number.isFinite(c.accuracy) ? Math.round(c.accuracy) : null;
          // 设备给的是 WGS-84，进业务流程前先换算成高德的 GCJ-02
          const gcj = wgs84ToGcj02(lng, lat);
          finish({
            coord: [Number(gcj[0].toFixed(6)), Number(gcj[1].toFixed(6))],
            wgs84: [Number(lng.toFixed(6)), Number(lat.toFixed(6))],
            datum: 'gcj02',
            accuracy: acc,
            city: '当前位置',
            address: acc != null ? `精度 ±${acc} m` : '已获取设备坐标',
            live: true
          });
        },
        err => {
          clearTimeout(timer);
          finish(null);
          // 把失败原因留给上层做文案，别在控制台留下未捕获异常
          lastGeoError = (err && err.code) || 0;
        },
        { enableHighAccuracy: true, timeout: 13000, maximumAge: 0 }
      );
    });
  }

  async function locateCurrent() {
    // ① 实时定位优先：先问浏览器要设备坐标
    const live = await browserLocate();
    if (live) {
      // 补地址有三条路，能补上就补，补不上也不影响实时坐标
      const named = await serverRegeo(live.coord);
      if (named) return Object.assign({}, live, { city: named.city, address: named.address });

      if (await probeAmap()) {
        try {
          await loadSDK();
          const byAmap = await amapRegeo(live.coord);
          if (byAmap) {
            return Object.assign({}, live, {
              city: byAmap.city || live.city,
              address: byAmap.address || live.address
            });
          }
        } catch (e) { /* 逆地理失败不降级，保留实时坐标 */ }
      }
      return live;
    }

    // ② 浏览器定位被拒 / 超时 → 有高德就用高德 IP 定位（精度较低，但仍是真位置）
    if (await probeAmap()) {
      try {
        await loadSDK();
        const res = await amapLocate();
        if (res && res.coord) return Object.assign({ ipLocated: true }, res);
      } catch (e) { /* 继续降级 */ }
    }

    // ③ 全部不可用 → 演示位置（明确标记，避免被当成真实定位）
    return demoLocation();
  }

  /* ---------------- 服务端代理（配了 Web 服务 Key 才生效） ---------------- */
  async function serverRegeo(coord) {
    if (isFilePreview()) return null;
    try {
      const res = await fetch('/api/geo/regeo?lng=' + coord[0] + '&lat=' + coord[1], { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.ok ? { city: data.city, address: data.address } : null;
    } catch (e) { return null; }
  }

  async function serverAround(coord, radius, types) {
    if (isFilePreview()) return null;
    try {
      const res = await fetch('/api/geo/around?lng=' + coord[0] + '&lat=' + coord[1] +
        '&radius=' + radius + '&types=' + encodeURIComponent(types || TYPES_DEFAULT), { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !data.ok || !Array.isArray(data.places)) return null;
      return data.places;
    } catch (e) { return null; }
  }

  /* 把实时坐标反查成「省市区 + 地址」，仅在高德可用时调用 */
  function amapRegeo(coord) {
    return new Promise((resolve, reject) => {
      try {
        AMap.plugin('AMap.Geocoder', () => {
          const geocoder = new AMap.Geocoder({ radius: 800, extensions: 'all' });
          geocoder.getAddress(coord, (status, result) => {
            if (status !== 'complete' || !result || !result.regeocode) {
              reject(new Error('逆地理编码失败'));
              return;
            }
            const rg = result.regeocode;
            const comp = rg.addressComponent || {};
            const cityName = pickStr(comp.city) || pickStr(comp.province);
            const city = (cityName + pickStr(comp.district)) || '当前位置';
            resolve({
              city,
              address: pickStr(rg.formattedAddress) || city
            });
          });
        });
      } catch (e) { reject(e); }
    });
  }

  function amapLocate() {
    return new Promise((resolve, reject) => {
      try {
        AMap.plugin('AMap.Geolocation', () => {
          const geolocation = new AMap.Geolocation({
            enableHighAccuracy: true, timeout: 8000, convert: true,
            showButton: false, needAddress: true
          });
          geolocation.getCurrentPosition((status, result) => {
            if (status !== 'complete' || !result || !result.position) {
              reject(new Error((result && (result.message || result.info)) || '定位失败'));
              return;
            }
            const position = result.position;
            const coord = typeof position.getLng === 'function'
              ? [position.getLng(), position.getLat()]
              : [Number(position.lng), Number(position.lat)];
            if (!Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) {
              reject(new Error('没有返回有效坐标'));
              return;
            }
            const component = result.addressComponent || {};
            resolve({
              coord,
              city: (pickStr(component.city) || pickStr(component.province)) || '当前位置',
              address: pickStr(result.formattedAddress) || pickStr(result.address) || '已获取当前位置'
            });
          });
        });
      } catch (error) { reject(error); }
    });
  }

  /* =========================================================
     机构筛选：三层闸门
     ---------------------------------------------------------
     ① 类别层（治「结果偏差」）
        只向高德请求「综合医院(090100)」；只有眼科/口腔这类
        有专门子码的科目，才额外请求对应专科码（090203/090202）。
        绝不请求 090200（会带出医美+口腔）、090300（诊所）、
        090000（含药房）。源头不捞，后面就不用靠删。
     ② 机构层（治「不是能看病的机构」）
        药店/医美/整形/养生/视光/体检/医疗器械公司 全部排除；
        名字里带「有限责任公司/有限公司」的商业挂靠机构也排除。
     ③ 科目层（治「混进别的科」）
        名称带专科标记（口腔/眼科/妇幼/肿瘤…）的机构，
        只在所选科目与之相符时才保留；没有专科标记的综合类机构
        （综合医院、三甲、社区卫生服务中心、卫生院、校医院）
        各科都能作为就诊点。选全科时，专科机构一律不进候选。
     ========================================================= */

  /* 名字里必须出现「能挂号看病的机构」词；高德上不少专科机构就叫
     「XX眼科」「XX口腔」，所以以专科名结尾的也算（末尾限定，避免把
     「XX护眼中心」这类非诊疗点算进来） */
  const INSTITUTION_RE = /(医院|卫生院|卫生服务中心|社区卫生服务站|医疗中心|医学中心|门诊部|诊所|卫生所|校医院|保健院|防治院)/;
  const SPECIALTY_CLINIC_RE = /(眼科|口腔|牙科|齿科|耳鼻喉|五官科)$/;

  function isInstitution(name) {
    return INSTITUTION_RE.test(name) || SPECIALTY_CLINIC_RE.test(name);
  }

  /* 非诊疗场所 / 商业机构：名字里带「诊所」也不算可就诊机构 */
  const EXCLUDE_RE = /(药店|药房|医药|医疗器械|医疗美容|医美|整形|美容|皮肤管理|养生|经络|理疗馆|月子|体检|检验|视光|眼镜|口腔护理|义齿|宠物|动物|养老|护理院|有限责任公司|有限公司|股份公司)/;

  /* 机构名称里的专科标记 → 内部科目标签（顺序会影响同时命中时的判定） */
  const SPECIALTY_RULES = [
    ['dental', /(口腔|牙科|齿科)/],
    ['eye', /(眼科|眼耳鼻喉)/],
    ['ent', /(耳鼻咽喉|耳鼻喉)/],
    ['derm', /(皮肤)/],
    ['obgyn', /(妇产|妇科|妇幼|产科|生殖)/],
    ['peds', /(儿童|儿科|小儿)/],
    ['onco', /(肿瘤|癌症)/],
    ['psych', /(精神|心理|脑科)/],
    ['ortho', /(骨科|骨伤|创伤|脊柱)/],
    ['cardio', /(心血管|心脏|胸科)/],
    ['gastro', /(消化|胃肠|肛肠|肝病)/],
    ['neuro', /(神经)/],
    ['resp', /(呼吸|肺科|结核)/],
    ['uro', /(泌尿|肾病|前列腺)/],
    ['endocrine', /(内分泌|糖尿病|甲状腺)/],
    ['tcm', /(中医|中西医)/],
    ['rehab', /(康复)/]
  ];

  /* 科室 → 科目标签。空串表示「综合类」，只接受没有专科标记的机构 */
  const DEPT_TAG = {
    '心血管内科': 'cardio', '消化内科': 'gastro', '神经内科': 'neuro',
    '呼吸内科': 'resp', '皮肤科': 'derm', '骨科': 'ortho',
    '妇科': 'obgyn', '产科': 'obgyn', '泌尿外科': 'uro', '眼科': 'eye',
    '耳鼻咽喉科': 'ent', '精神心理科': 'psych', '内分泌科': 'endocrine',
    '口腔科': 'dental', '肿瘤科': 'onco', '儿科': 'peds',
    '康复科': 'rehab', '中医科': 'tcm',
    '全科医学科': '', '普通内科': '', '内科': '', '全科': ''
  };

  /* 高德 POI 类型码：只开放这三个组合，其余一律不请求 */
  const TYPES_DEFAULT = '090100';              // 综合医院 / 三甲 / 社区卫生服务中心
  const TYPES_BY_TAG = {
    eye: '090100|090203',                      // 综合医院 + 眼科专科
    dental: '090100|090202'                    // 综合医院 + 口腔专科
  };

  function specialtyTags(name) {
    const tags = new Set();
    SPECIALTY_RULES.forEach(([tag, re]) => { if (re.test(name)) tags.add(tag); });
    return tags;
  }

  function tagForDept(dept) {
    const d = String(dept || '').trim();
    if (Object.prototype.hasOwnProperty.call(DEPT_TAG, d)) return DEPT_TAG[d];
    // 模型偶尔会给出没登记的科室名，按关键词兜底
    for (const pair of SPECIALTY_RULES) if (pair[1].test(d)) return pair[0];
    return '';
  }

  function typesForDept(dept) {
    return TYPES_BY_TAG[tagForDept(dept)] || TYPES_DEFAULT;
  }

  /* 这家机构能不能作为「dept 这个科」的就诊点 */
  function placeAllowed(name, dept) {
    const n = String(name || '').trim();
    if (!n || !isInstitution(n)) return false;
    if (EXCLUDE_RE.test(n)) return false;

    const tags = specialtyTags(n);
    if (!tags.size) return true;                       // 综合类：任何科目都能看

    // 中医医院本身是综合性的，只有当科目就是中医时才按专科处理
    const want = tagForDept(dept);
    if (tags.size === 1 && tags.has('tcm') && want !== 'tcm') return true;

    if (!want) return false;                           // 全科：专科机构不进候选
    return tags.has(want);                             // 专科：只留本科室对应的机构
  }

  /* 同一家医院的「门诊楼 / 住院部 / 急诊 / 体检中心 / 南院区」等子 POI 归并为主名称，
     否则一家医院会占满整个列表，把其他机构挤出去 */
  function baseName(name) {
    const suffix = /(门诊楼|住院楼|住院部|住院|急诊楼|门急诊|急诊|发热门诊|门诊部|体检中心|健康管理中心|预防接种门诊|体检|国际部|干保门诊|南院区|北院区|东院区|西院区|院区)$/;
    let out = String(name).replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '');
    let prev;
    do { prev = out; out = out.replace(suffix, ''); } while (out !== prev);
    return out.length >= 4 ? out : String(name).trim();
  }

  /* 统一收口：过滤 → 距离排序 → 一院一条 */
  function finalizePlaces(places, dept) {
    const seen = new Set();
    const kept = [];

    places
      .filter(p => p && p.coord && Number.isFinite(p.distance) && placeAllowed(p.name, dept))
      .sort((a, b) => a.distance - b.distance)
      .forEach(p => {
        const short = baseName(p.name);
        const name = short.length >= 4 ? short : p.name;
        if (seen.has(name)) return;

        // 「曹家堡社区卫生服务站」与「雁塔区杜城曹家堡社区卫生服务站」、
        // 「西安工会医院」与「西安工会医院-工人医院」是同一个院区，
        // 名称互相包含时按最近的一条收编
        const dup = kept.some(k => {
          const a = k.name, b = name;
          const longer = a.length >= b.length ? a : b;
          const shorter = a.length >= b.length ? b : a;
          return shorter.length >= 5 && longer.indexOf(shorter) >= 0;
        });
        if (dup) return;

        seen.add(name);
        kept.push(Object.assign({}, p, { name }));
      });

    return kept;
  }

  async function searchNearbyHospitals(center, radius, dept) {
    const types = typesForDept(dept);

    // ① 服务端代理（配了高德 Web 服务 Key）→ 真实医院
    const real = await serverAround(center, radius, types);
    if (real) return finalizePlaces(real, dept);

    // ② 高德 JS API 可用 → 真实 POI
    if (await probeAmap()) {
      try {
        await loadSDK();
        const list = await amapSearch(center, radius, types);
        return finalizePlaces(list, dept);
      } catch (e) { /* 落回本地数据 */ }
    }

    // ③ 本地演示数据（按你的真实位置平移，距离方位保持一致）
    return finalizePlaces(demoHospitals(center, radius), dept);
  }

  function amapSearch(center, radius, types) {
    return new Promise((resolve, reject) => {
      try {
        AMap.plugin('AMap.PlaceSearch', () => {
          const service = new AMap.PlaceSearch({
            type: types || TYPES_DEFAULT,
            pageSize: 25, pageIndex: 1, extensions: 'base'
          });
          service.searchNearBy('', center, radius, (status, result) => {
            if (status !== 'complete' || !result || !result.poiList) {
              reject(new Error((result && (result.info || result.message)) || '附近医院搜索失败'));
              return;
            }
            const pois = result.poiList.pois || [];

            const places = pois.map((poi, index) => {
              const name = String(poi.name || '').trim();
              if (!name) return null;

              const loc = poi.location;
              if (!loc) return null;
              const coord = typeof loc.getLng === 'function'
                ? [loc.getLng(), loc.getLat()]
                : [Number(loc.lng), Number(loc.lat)];
              if (!Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) return null;

              return {
                id: poi.id ? String(poi.id) : 'amap-' + name + '-' + index,
                name,
                address: String(poi.address == null ? '' : poi.address).replace(/^.*?[省市区县旗]/, '') || '',
                distance: distanceMeters(center, coord),
                coord
              };
            }).filter(Boolean);

            resolve(places);
          });
        });
      } catch (error) { reject(error); }
    });
  }

  function destroy() {
    if (amap) { try { amap.destroy(); } catch (e) {} amap = null; }
  }

  /* ---------------- 高德地图 ---------------- */
  /* 按「当前位置 + 附近医院」的实际跨度算出初始视野。
     地图初始化后再调 setZoom 会被 AMap 忽略，所以必须直接写进构造参数。 */
  function fitView(home, places) {
    const pts = [home.coord].concat(places.filter(p => p.coord).map(p => p.coord));
    if (pts.length < 2) return { zoom: 14, center: home.coord };

    let sumLng = 0, sumLat = 0;
    pts.forEach(p => { sumLng += p[0]; sumLat += p[1]; });
    const center = [sumLng / pts.length, sumLat / pts.length];

    let span = 0;
    pts.forEach(p => {
      span = Math.max(span,
        Math.abs(p[0] - center[0]) * 102000 * Math.cos(center[1] * Math.PI / 180),
        Math.abs(p[1] - center[1]) * 110540);
    });

    let zoom = 16;
    if (span > 250) zoom = 15;
    if (span > 700) zoom = 14;
    if (span > 1600) zoom = 13;
    if (span > 3500) zoom = 12;
    return { zoom, center };
  }

  function renderAMap(el, opts) {
    if (el.clientHeight < 60) {
      setTimeout(() => renderAMap(el, opts), 140);
      return;
    }
    if (amap) {
      // 位置变了：直接丢掉旧视野，按新位置重新算；位置没变：记住用户拖到哪
      if (resetView) {
        viewState = null;
      } else {
        try { viewState = { zoom: amap.getZoom(), center: amap.getCenter() }; } catch (e) {}
      }
    }
    resetView = false;
    destroy();
    el.innerHTML = '<div id="amapCanvas" style="width:100%;height:100%"></div>';
    const home = opts.home;
    const view = viewState || fitView(home, opts.places);

    amap = new AMap.Map('amapCanvas', {
      zoom: view.zoom,
      center: view.center,
      mapStyle: 'amap://styles/light',
      showLabel: true,
      viewMode: '2D'
    });

    if (AMap.Scale) amap.addControl(new AMap.Scale({ position: 'LB' }));

    const homeMarker = new AMap.Marker({
      position: home.coord,
      content: '<div class="amap-pin home">当前位置</div>',
      anchor: 'bottom-center',
      offset: new AMap.Pixel(0, -2),
      zIndex: 120
    });
    amap.add(homeMarker);

    const target = opts.places.find(p => p.id === opts.selected) || opts.places[0];
    const markers = [homeMarker];

    opts.places.forEach(p => {
      if (!p.coord) return;
      const mk = new AMap.Marker({
        position: p.coord,
        content: '<div class="amap-pin ' + (p.id === opts.selected ? 'on' : '') + '" title="' + escapeHtml(p.name) + '"></div>',
        anchor: 'bottom-center',
        offset: new AMap.Pixel(0, -2),
        zIndex: 100,
        title: p.name
      });
      mk.on('click', () => opts.onPick && opts.onPick(p.id));
      amap.add(mk);
      markers.push(mk);
    });

    if (target && target.coord) {
      amap.add(new AMap.Polyline({
        path: [home.coord, target.coord],
        strokeColor: '#12B886', strokeWeight: 3, strokeOpacity: 0.85,
        strokeStyle: 'dashed', strokeDasharray: [6, 6], zIndex: 60
      }));

      // 选中项在真实底图上标出名字：10 个孤立圆点读不出「哪家是哪家」
      const tip = shortName(target.name);
      amap.add(new AMap.Marker({
        position: target.coord,
        content: '<div class="amap-tip">' + escapeHtml(tip.length > 15 ? tip.slice(0, 15) + '…' : tip) + '</div>',
        anchor: 'bottom-center',
        offset: new AMap.Pixel(0, -36),
        zIndex: 130,
        bubble: true
      }));
    }

    try { amap.setLimitZoom([12, 18]); } catch (e) {}
  }

  /* ---------------- 本地演示地图 ----------------
     按真实经纬度做等距投影：纬度差换算成米，再等比缩放进画布。
     医院之间的相对方位、与「当前位置」的距离比例都是真实的，
     只把底图换成轻量的街区底纹（不再依赖任何在线瓦片）。       */

  function metersPerDegree(lat) {
    return { x: 111320 * Math.cos(lat * Math.PI / 180), y: 110540 };
  }

  function niceStep(meters) {
    const ladder = [500, 1000, 2000, 3000, 5000, 10000, 20000];
    return ladder.find(v => v >= meters) || 20000;
  }

  function kmLabel(meters) {
    return meters >= 1000 ? (meters / 1000).toFixed(1) + ' km' : (Math.round(meters / 10) * 10) + ' m';
  }

  /* 医院全名放进列表，图上只留能一眼读的核心名 */
  const NAME_PREFIX = /^(复旦大学附属|上海交通大学医学院附属|上海交通大学附属|上海中医药大学附属|同济大学附属|海军军医大学附属|第二军医大学附属|上海市|上海)/;
  function shortName(name) {
    const out = String(name).replace(NAME_PREFIX, '').trim();
    return out.length >= 3 ? out : String(name);
  }

  /* 让标注互不压字：默认在点位下方，撞了往下推，出界翻到上方 */
  function textWidth(text) {
    let n = 0;
    for (const ch of String(text)) n += /[一-龥]/.test(ch) ? 11.2 : 6.4;
    return Math.round(n + 18);
  }

  function placeLabels(items, W, H, safeBottom, reserved) {
    const placed = items.map(it => ({ x: it.x - 12, y: it.y - 12, w: 24, h: 24 }));
    (reserved || []).forEach(r => placed.push(r));
    const hit = (r) => placed.some(o =>
      r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
    const maxY = H - safeBottom;

    items.forEach(it => {
      const w = Math.min(W - 16, textWidth(it.text));
      const h = 21;
      const clampX = x => Math.max(8, Math.min(W - w - 8, x));
      // 依次尝试：下 / 上 / 右 / 左，像真地图那样贴着点位找空位
      const cands = [
        { x: clampX(it.x - w / 2), y: it.y + 12 },
        { x: clampX(it.x - w / 2), y: it.y - 12 - h },
        { x: clampX(it.x + 12), y: it.y - h / 2 },
        { x: clampX(it.x - 12 - w), y: it.y - h / 2 }
      ];
      let best = null;
      for (const c of cands) {
        const r = { x: c.x, y: c.y, w, h };
        if (r.y < 6 || r.y + h > maxY) continue;
        if (!hit(r)) { best = r; break; }
      }
      if (!best) {
        let y = it.y + 12, guard = 0;
        let r = { x: clampX(it.x - w / 2), y, w, h };
        while (hit(r) && guard < 12) { y += h + 3; r = { x: clampX(it.x - w / 2), y, w, h }; guard++; }
        if (y + h > maxY) {
          y = Math.max(6, Math.min(maxY - h, it.y - 12 - h));
          r = { x: clampX(it.x - w / 2), y, w, h };
        }
        best = r;
      }
      placed.push(best);
      it.label = best;
    });
  }

  /* 固定种子的伪随机：每次重绘街区形状一致，不会闪动 */
  function seeded(seed) {
    let s = seed;
    return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  }

  function renderSchematic(el, opts, note) {
    destroy();
    const places = (opts.places || []).filter(p => p.coord && p.coord.length === 2);
    const home = opts.home || {};
    const homeCoord = home.coord && home.coord.length === 2 ? home.coord : DEMO.coord;

    // 画布直接用容器像素尺寸：文字按真实字号渲染，不会被缩成蚂蚁字
    const W = Math.max(360, Math.round(el.clientWidth || 720));
    const H = Math.max(320, Math.round(el.clientHeight || 440));
    const safeBottom = 36;            // 给比例尺与说明留出净空
    const padX = 58, padTop = 46, padBottom = 54 + safeBottom;

    if (!places.length) {
      el.innerHTML = '<div class="empty-results">这个范围内暂时没有医院，可以扩大搜索半径后再试。</div>';
      return;
    }

    const { x: kx, y: ky } = metersPerDegree(homeCoord[1]);
    const raw = places.map(p => ({
      p,
      mx: (p.coord[0] - homeCoord[0]) * kx,
      my: -(p.coord[1] - homeCoord[1]) * ky
    }));

    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    raw.forEach(r => {
      minX = Math.min(minX, r.mx); maxX = Math.max(maxX, r.mx);
      minY = Math.min(minY, r.my); maxY = Math.max(maxY, r.my);
    });

    const availW = W - padX * 2;
    const availH = H - padTop - padBottom;
    const bw = Math.max(maxX - minX, 400);
    const bh = Math.max(maxY - minY, 400);

    // 等比缩放：1 米在画布上占多少像素，横竖统一
    let scale = Math.min(availW / bw, availH / bh);
    scale = Math.min(scale, availW * 0.5 / 1200);   // 上限：1.2km 最长占半幅宽

    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const toXY = (coord) => {
      const mx = (coord[0] - homeCoord[0]) * kx;
      const my = -(coord[1] - homeCoord[1]) * ky;
      return [
        W / 2 + (mx - cx) * scale,
        padTop + availH / 2 + (my - cy) * scale
      ];
    };

    const [hx, hy] = toXY(homeCoord);
    const pins = raw.map(r => {
      const [x, y] = toXY(r.p.coord);
      return {
        id: r.p.id, name: r.p.name, short: shortName(r.p.name),
        distance: Number.isFinite(r.p.distance) ? r.p.distance : distanceMeters(homeCoord, r.p.coord),
        x, y
      };
    });

    const selected = pins.find(p => p.id === opts.selected) || pins[0];
    const maxDist = Math.max(...pins.map(p => p.distance || 0), 600);

    // 选中项把距离直接写进标注，不再飘一个距离浮签压住别的文字
    pins.forEach(p => {
      p.text = p.id === selected.id ? p.short + ' · ' + kmLabel(p.distance) : p.short;
    });
    placeLabels(pins, W, H, safeBottom, [
      { x: hx - 34, y: hy - 34, w: 68, h: 24 },
      { x: hx - 16, y: hy - 16, w: 32, h: 32 }
    ]);

    /* 底纹：两层街区 + 主次路网，让画面读起来像城区而不是白纸 */
    const rand = seeded(20261022);
    let blocks = '';
    for (let i = 0; i < 40; i++) {
      const bx = rand() * W;
      const by = rand() * H;
      const bwid = 30 + rand() * 86;
      const bhei = 24 + rand() * 62;
      blocks += `<rect x='${bx.toFixed(1)}' y='${by.toFixed(1)}' width='${bwid.toFixed(1)}' height='${bhei.toFixed(1)}' rx='3' fill='#E1ECE5' opacity='${(0.5 + rand() * 0.3).toFixed(2)}'/>`;
    }
    const rand2 = seeded(77123);
    for (let i = 0; i < 26; i++) {
      const bx = rand2() * W;
      const by = rand2() * H;
      blocks += `<rect x='${bx.toFixed(1)}' y='${by.toFixed(1)}' width='${(16 + rand2() * 40).toFixed(1)}' height='${(14 + rand2() * 30).toFixed(1)}' rx='2' fill='#DAE7E0' opacity='${(0.35 + rand2() * 0.3).toFixed(2)}'/>`;
    }
    const roads =
      `<g stroke='#FFFFFF' stroke-linecap='round'>` +
      [0.18, 0.44, 0.72, 0.9].map(k => `<path d='M0 ${(H * k).toFixed(0)}H${W}' stroke-width='9' opacity='.92'/>`).join('') +
      [0.22, 0.52, 0.8].map(k => `<path d='M${(W * k).toFixed(0)} 0V${H}' stroke-width='9' opacity='.92'/>`).join('') +
      [0.32, 0.58, 0.84].map(k => `<path d='M0 ${(H * k).toFixed(0)}H${W}' stroke-width='4' opacity='.7'/>`).join('') +
      [0.36, 0.66].map(k => `<path d='M${(W * k).toFixed(0)} 0V${H}' stroke-width='4' opacity='.7'/>`).join('') +
      `</g>`;

    /* 距离环：真实比例；标签放左下，避开医院密集的上方 */
    const usableR = Math.min(W - padX * 1.2, H - padTop - padBottom) / 2 + 16;
    const step = niceStep(maxDist / 2.2);
    let rings = '';
    let ringCount = 0;
    for (let d = step; d <= step * 3 && ringCount < 3; d += step) {
      const r = d * scale;
      if (r > usableR) break;
      ringCount++;
      rings += `<circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="#C6DAD0" stroke-width="1" stroke-dasharray="3 6"/>`;
      rings += `<text x="${Math.max(8, hx - r * 0.95).toFixed(1)}" y="${(hy + r * 0.32 + 4).toFixed(1)}" font-size="9.5" fill="#ACBEB4">${kmLabel(d)}</text>`;
    }

    /* 连线：当前位置 → 选中医院 */
    let linkSvg = '';
    if (selected && Math.hypot(selected.x - hx, selected.y - hy) > 26) {
      linkSvg = `<path d="M${hx.toFixed(1)} ${hy.toFixed(1)} L${selected.x.toFixed(1)} ${selected.y.toFixed(1)}"
        stroke="#12B886" stroke-width="1.8" stroke-dasharray="5 5" opacity=".8" fill="none"/>`;
    }

    /* 当前位置：先画，医院点位压在上层 */
    const homeLabelUp = hy - 34 > 8;
    // 实时定位时把设备给的精度半径画出来，一眼能看出「定位有多准」
    const accR = opts.live && Number.isFinite(opts.accuracy)
      ? Math.max(14, Math.min(96, opts.accuracy * scale))
      : 0;
    const homeSvg = `<g pointer-events="none">
      ${accR ? `<circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="${accR.toFixed(1)}"
        fill="#12B886" fill-opacity=".09" stroke="#12B886" stroke-opacity=".28" stroke-width="1" stroke-dasharray="4 5"/>` : ''}
      <circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="30" fill="url(#homePulse)"/>
      <circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="8.5" fill="#22352E" stroke="#FFFFFF" stroke-width="2.2"/>
      <circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="3" fill="#FFFFFF"/>
      <g transform="translate(${(hx - 32).toFixed(1)},${(homeLabelUp ? hy - 32 : hy + 15).toFixed(1)})">
        <rect width="64" height="20" rx="6" fill="#22352E"/>
        <text x="32" y="14" text-anchor="middle" font-size="10.5" fill="#FFFFFF" font-weight="600">当前位置</text>
      </g>
    </g>`;

    /* 点位：未选中先画，选中项最后画，保证压在最上层 */
    const ordered = pins.slice().sort((a, b) => (a.id === selected.id ? 1 : 0) - (b.id === selected.id ? 1 : 0));
    const pinSvg = ordered.map(p => {
      const on = p.id === selected.id;
      const lx = p.label.x, ly = p.label.y, lw = p.label.w, lh = p.label.h;
      // 标注离点位远时补一条引线，避免「标签和点位对不上」
      const cxL = lx + lw / 2, cyL = ly + lh / 2;
      const gapX = Math.max(0, Math.abs(cxL - p.x) - lw / 2);
      const gapY = Math.max(0, Math.abs(cyL - p.y) - lh / 2);
      const leader = Math.hypot(gapX, gapY) > 9
        ? `<path d="M${p.x.toFixed(1)} ${p.y.toFixed(1)} L${cxL.toFixed(1)} ${cyL.toFixed(1)}"
            stroke="${on ? '#0A7B58' : '#B6CDC1'}" stroke-width="1" fill="none" opacity=".7"/>`
        : '';

      return `<g class="mpin" data-place="${escapeHtml(p.id)}" style="cursor:pointer">
        ${on ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="16" fill="#12B886" opacity=".15"/>` : ''}
        ${leader}
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${on ? 9 : 7}" fill="${on ? '#0A7B58' : '#12B886'}" stroke="#FFFFFF" stroke-width="2"/>
        <path d="M${(p.x - 3).toFixed(1)} ${p.y.toFixed(1)}h6M${p.x.toFixed(1)} ${(p.y - 3).toFixed(1)}v6"
          stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round"/>
        <rect x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" width="${lw.toFixed(1)}" height="${lh}" rx="6"
          fill="${on ? '#0A7B58' : '#FFFFFF'}" stroke="${on ? '#0A7B58' : '#D8E7DF'}"/>
        <text x="${(lx + lw / 2).toFixed(1)}" y="${(ly + 14.5).toFixed(1)}" text-anchor="middle" font-size="10.5"
          fill="${on ? '#FFFFFF' : '#26493D'}" font-weight="${on ? 600 : 500}">${escapeHtml(p.text)}</text>
      </g>`;
    }).join('');



    const barMeters = niceStep(Math.min(maxDist / 4, 4000));
    const barPx = Math.max(24, Math.min(120, barMeters * scale));

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet"
        style="display:block" font-family="'PingFang SC','Microsoft YaHei',system-ui,sans-serif">
      <defs>
        <linearGradient id="mapWash" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#F9FCFA"/><stop offset="1" stop-color="#EEF6F1"/>
        </linearGradient>
        <radialGradient id="homePulse" cx=".5" cy=".5" r=".5">
          <stop stop-color="#12B886" stop-opacity=".2"/><stop offset="1" stop-color="#12B886" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#mapWash)"/>
      ${blocks}
      ${roads}
      <path d="M-10 ${(H * .9).toFixed(0)} C ${(W * .26).toFixed(0)} ${(H * .82).toFixed(0)}, ${(W * .34).toFixed(0)} ${(H * 1.02).toFixed(0)}, ${(W * .6).toFixed(0)} ${(H * .96).toFixed(0)}
        S ${(W * .86).toFixed(0)} ${(H * .84).toFixed(0)}, ${W + 10} ${(H * .88).toFixed(0)} L ${W + 10} ${H + 10} L -10 ${H + 10} Z"
        fill="#E1EFF3" opacity=".7"/>
      ${rings}
      ${linkSvg}
      ${homeSvg}
      ${pinSvg}
      <g pointer-events="none" transform="translate(${(W - barPx - 16).toFixed(1)},${(H - 18).toFixed(1)})">
        <path d="M0 0v-5M${barPx.toFixed(1)} 0v-5M0 -2.5h${barPx.toFixed(1)}" stroke="#9BB0A6" stroke-width="1.1" fill="none"/>
        <text x="${(barPx / 2).toFixed(1)}" y="-9" text-anchor="middle" font-size="9.5" fill="#9BB0A6">${kmLabel(barMeters)}</text>
      </g>
      <g pointer-events="none" transform="translate(${(W - 12).toFixed(1)},26)" text-anchor="end">
        <text font-size="9.5" fill="#B6C7BE" letter-spacing="1.6">示意范围</text>
      </g>
    </svg>
    <div class="map-note">${opts.live ? '实时定位已启用 · 底图为示意图，医院点位为演示数据' : (note || '本地演示地图 · 坐标为演示数据')}</div>`;

    el.querySelectorAll('.mpin').forEach(g => {
      g.addEventListener('click', () => opts.onPick && opts.onPick(g.dataset.place));
    });
  }


  function reset(){ viewState = null; lastHome = null; resetView = false; forceLocal = false; lastEl = null; lastOpts = null; lastMode = ''; destroy(); }
  function toggleLocal(){ forceLocal = !forceLocal; return forceLocal; }
  function isLocal(){ return forceLocal; }

  return {
    render, select, destroy, reset, hasKey, toggleLocal, isLocal,
    locateCurrent, searchNearbyHospitals, unavailableReason,
    wgs84ToGcj02, placeAllowed, tagForDept, typesForDept
  };
})();
