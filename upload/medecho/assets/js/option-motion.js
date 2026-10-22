/* 同频 MedEcho · 选项确认过渡（表现层）
   ---------------------------------------------------------
   做两件事，都只发生在「用户点选选项、内容被替换」的这一刻：
   1) 旧内容复制成一层浮层，淡出（避免内容瞬消失造成的硬切）
   2) 新题面与选项依次淡入上浮，形成交叉过渡
   不修改 booking.js 的任何逻辑、事件与状态；系统开启「减少动效」时静默跳过。
*/
(function () {
  'use strict';

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var panel = document.querySelector('#followupPanel .ask-main');
  var grid = document.getElementById('optionGrid');
  var question = document.getElementById('followupQuestion');
  var hint = document.getElementById('followupHint');
  var meter = document.getElementById('followupMeter');
  if (!panel || !grid || !question) return;

  var armed = false;     // 仅「点选选项」触发的替换才播动画
  var queued = 0;
  var idleTimer = 0;
  var ghostEl = null;

  function clearGhost() {
    if (ghostEl && ghostEl.parentNode) ghostEl.parentNode.removeChild(ghostEl);
    ghostEl = null;
  }

  /* ---------- 旧内容淡出：复制一层浮层盖在原位 ---------- */
  function stripIds(node) {
    node.removeAttribute('id');
    var kids = node.querySelectorAll('[id]');
    for (var i = 0; i < kids.length; i++) kids[i].removeAttribute('id');
    return node;
  }

  function buildGhost() {
    var head = panel.querySelector('.ask-head');
    if (!head || panel.offsetParent === null) return null;
    clearGhost();   // 连续快速点选时只保留最新的一层，避免叠影

    var h = head.getBoundingClientRect();
    var g = grid.getBoundingClientRect();
    if (!h.height || !g.height) return null;

    var ghost = document.createElement('div');
    ghost.className = 'fu-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.left = h.left + 'px';
    ghost.style.top = h.top + 'px';
    ghost.style.width = h.width + 'px';
    ghost.style.height = Math.max(0, g.bottom - h.top) + 'px';

    var bg = window.getComputedStyle(panel).backgroundColor;
    ghost.style.background = (!bg || bg === 'rgba(0, 0, 0, 0)') ? '#fff' : bg;

    var headClone = stripIds(head.cloneNode(true));
    headClone.style.cssText = 'position:absolute;left:0;top:0;width:100%;margin:0';
    ghost.appendChild(headClone);

    if (g.height) {
      var gridClone = stripIds(grid.cloneNode(true));
      gridClone.style.cssText =
        'position:absolute;left:0;top:' + Math.round(g.top - h.top) + 'px;width:100%;margin:0';
      ghost.appendChild(gridClone);
    }

    document.body.appendChild(ghost);
    ghostEl = ghost;
    var clean = function () {
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
      if (ghostEl === ghost) ghostEl = null;
    };
    ghost.addEventListener('animationend', clean, { once: true });
    setTimeout(clean, 1600);   // 兜底：动画事件丢失也不留残影
    return ghost;
  }

  /* ---------- 新内容进入 ---------- */
  function play(el, delay) {
    if (!el || reduceMotion) return;
    el.classList.remove('fu-in');
    void el.offsetWidth;                        // 强制重排，使同名动画可重播
    el.style.animationDelay = (delay || 0) + 'ms';
    el.classList.add('fu-in');
    el.addEventListener('animationend', function () {
      el.classList.remove('fu-in');
      el.style.animationDelay = '';
    }, { once: true });
  }

  function pop(el) {
    if (!el || reduceMotion) return;
    el.classList.remove('fu-pop');
    void el.offsetWidth;
    el.classList.add('fu-pop');
    el.addEventListener('animationend', function () {
      el.classList.remove('fu-pop');
    }, { once: true });
  }

  function run() {
    if (!armed || reduceMotion) return;
    armed = false;

    // 已经切到别的页面（例如点最后一项直接出结果）：不留浮层，也不播动画
    if (!panel.offsetParent) { clearGhost(); return; }

    // ① 题面先到
    play(question, 0);
    if (hint) play(hint, 50);

    // ② 选项依次跟上：60ms 起，每项递延 45ms
    var options = grid.querySelectorAll('.opt-btn');
    for (var i = 0; i < options.length; i++) {
      play(options[i], 60 + i * 45);
    }

    // ③ 刚点亮的进度点轻轻弹一下，作为「已确认」的回执
    if (meter) {
      var dots = meter.querySelectorAll('i.on');
      if (dots.length) pop(dots[dots.length - 1]);
    }
  }

  function schedule() {
    if (!armed || queued) return;
    queued = requestAnimationFrame(function () {
      queued = 0;
      run();
    });
  }

  // 捕获阶段先于按钮自身的处理函数：此时旧内容还在，正好复制一层
  grid.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.opt-btn') : null;
    if (!btn) return;
    armed = true;
    if (!reduceMotion) buildGhost();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { armed = false; }, 20000);  // 兜底，不留悬空状态
  }, true);

  var mo = new MutationObserver(schedule);
  mo.observe(grid, { childList: true });
  mo.observe(question, { childList: true, characterData: true, subtree: true });
})();
