// ═══ MAIN world：挂钩抖音页面的 fetch / XHR，拦截搜索签名接口响应原文 ═══
// 与云端 douyin.py 同一思路：不手写签名，直接拿前端自动签名后的接口响应。
// 捕获到后 window.postMessage 给隔离世界的 content.js 转发回云端。
(function () {
  'use strict';
  const API_PAT = /aweme\/v1\/web\/search\/item\/|general\/search\/single/;

  function send(bodyText) {
    try {
      window.postMessage({ source: 'mf-ext-main', type: 'search-body', body: bodyText }, '*');
    } catch (e) { /* 忽略 */ }
  }

  // ── fetch 钩子 ──
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (API_PAT.test(url)) {
          const text = await res.clone().text();
          if (text) send(text);
        }
      } catch (e) { /* 忽略 */ }
      return res;
    };
  }

  // ── XHR 钩子 ──
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (method, url, ...rest) {
    this.__mfUrl = String(url || '');
    return origOpen.call(this, method, url, ...rest);
  };
  XHR.send = function (...args) {
    if (API_PAT.test(this.__mfUrl || '')) {
      this.addEventListener('load', function () {
        try {
          const t = this.responseText;
          if (t) send(t);
        } catch (e) { /* 忽略 */ }
      });
    }
    return origSend.apply(this, args);
  };
})();
