(function initDebug(root, factory) {
  const api = factory();
  root.DownloaderKit = root.DownloaderKit || {};
  root.DownloaderKit.debug = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function debugFactory() {
  function isEnabled(explicit, api) {
    if (explicit === false) return false;
    if (globalThis.DownloaderKit?.DEBUG === false) return false;
    const runtime = globalThis.DownloaderKit?.runtime;
    try {
      if (runtime?.isStoreBuild(api)) return false;
    } catch (_) {}
    if (explicit === true) return true;
    return globalThis.DownloaderKit?.DEBUG !== false;
  }

  function noop() {
    return {
      enabled: false,
      log() {},
      shortUrl(value) { return String(value || ''); },
      render() {},
      clear() {},
      copy() {},
      bind() {}
    };
  }

  function shortUrl(value) {
    try {
      const url = new URL(String(value || ''));
      const tail = url.pathname.split('/').filter(Boolean).pop() || '';
      return (url.hostname + '/' + tail).slice(0, 80);
    } catch (_) {
      return String(value || '').slice(0, 80);
    }
  }

  function create(options) {
    const opts = options || {};
    if (!isEnabled(opts.enabled, opts.api)) return noop();

    const doc = opts.document || globalThis.document;
    const idPrefix = opts.idPrefix || 'dl-kit';
    const tag = opts.logTag || 'DLKIT';
    const lines = [];

    function nodes() {
      return {
        logEl: doc?.getElementById?.(idPrefix + '-debug-log'),
        countEl: doc?.getElementById?.(idPrefix + '-debug-count'),
        copyEl: doc?.getElementById?.(idPrefix + '-debug-copy')
      };
    }

    function render() {
      const { logEl, countEl } = nodes();
      if (logEl) logEl.textContent = lines.join('\n') || '暂无日志';
      if (countEl) countEl.textContent = String(lines.length);
    }

    function log(...args) {
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const text = args.map((item) => {
        if (item && typeof item === 'object') {
          try { return JSON.stringify(item); } catch (_) { return String(item); }
        }
        return String(item);
      }).join(' ');
      lines.push('[' + time + '] ' + text);
      if (lines.length > 80) lines.shift();
      console.log('[' + tag + ']', ...args);
      render();
    }

    function clear() {
      lines.length = 0;
      render();
    }

    function copyViaTextarea(text) {
      const area = doc.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      doc.body.appendChild(area);
      area.focus();
      area.select();
      const ok = doc.execCommand('copy');
      area.remove();
      if (!ok) throw new Error('execCommand copy failed');
    }

    async function copy() {
      const { copyEl } = nodes();
      const text = lines.join('\n') || '暂无日志';
      try {
        if (globalThis.navigator?.clipboard?.writeText) await globalThis.navigator.clipboard.writeText(text);
        else copyViaTextarea(text);
      } catch (_) {
        copyViaTextarea(text);
      }
      if (copyEl) {
        copyEl.textContent = '已复制';
        setTimeout(() => { copyEl.textContent = '复制'; }, 1200);
      }
      log('调试日志已复制');
    }

    function bindButton(id, handler) {
      const button = doc?.getElementById?.(id);
      if (!button || button.__dlKitDebugBound) return;
      button.__dlKitDebugBound = true;
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        handler();
      });
    }

    function bind() {
      bindButton(idPrefix + '-debug-clear', clear);
      bindButton(idPrefix + '-debug-copy', () => {
        copy().catch((error) => log('复制失败', error.message || error));
      });
      render();
    }

    return { enabled: true, log, shortUrl, render, clear, copy, bind };
  }

  return { isEnabled, create, shortUrl };
});
