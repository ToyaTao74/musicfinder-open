// ═══ 隔离世界：转发拦截到的接口原文给后台；执行自动滚动翻页 ═══
(function () {
  'use strict';

  let task = null;        // {task_id, target_count}
  let scrollTimer = null;

  // MAIN world 的拦截结果 → background
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (d && d.source === 'mf-ext-main' && d.type === 'search-body' && d.body) {
      chrome.runtime.sendMessage({ type: 'body', body: d.body }).catch(() => {});
    }
  });

  // 通知后台本页就绪（后台会回传任务配置）
  chrome.runtime.sendMessage({ type: 'page-ready', url: location.href }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'start-task') {
      task = { task_id: msg.task_id, target_count: msg.target_count || 300 };
      startScrolling();
    }
  });

  function notifyProgress() {
    chrome.runtime.sendMessage({ type: 'progress', seenItems: seenItems }).catch(() => {});
  }

  let seenItems = 0;

  function startScrolling() {
    if (scrollTimer) clearInterval(scrollTimer);
    let noGrowth = 0;
    let lastCount = -1;
    scrollTimer = setInterval(() => {
      try { window.scrollBy(0, 3000); } catch (e) { /* 忽略 */ }
      // 页面里出现的视频卡片数（粗略进度）
      const cards = document.querySelectorAll('[data-e2e="scroll-list-item-item"], .search-result-card').length;
      if (cards !== lastCount) {
        seenItems = Math.max(seenItems, cards);
        lastCount = cards;
        noGrowth = 0;
        notifyProgress();
      } else {
        noGrowth++;
      }
      const enough = seenItems >= (task ? task.target_count : 300);
      // 连续 8 次(约10秒)没有新内容，或已达目标数 → 结束
      if (enough || noGrowth >= 8) {
        clearInterval(scrollTimer);
        scrollTimer = null;
        chrome.runtime.sendMessage({ type: 'page-done', seenItems: seenItems }).catch(() => {});
      }
    }, 1300);
  }
})();
