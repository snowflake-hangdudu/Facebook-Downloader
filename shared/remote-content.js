(function initRemoteContent(root, factory) {
  const api = factory();
  root.DownloaderKit = root.DownloaderKit || {};
  root.DownloaderKit.remote = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function remoteContentFactory() {
  const EMPTY_CONTENT = Object.freeze({
    notice: { enabled: false, title: '公告', body: '', pinned: [], recent: [], knownIssues: [], roadmap: {} },
    coop: { enabled: false, title: '开发合作', body: '' },
    rating: { enabled: false, url: '', edge: '', chrome: '', firefox: '', minSuccess: 3, minimumVersion: '' }
  });

  function section(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function mergeRemoteContent(value, defaults) {
    const source = section(value);
    const base = defaults || EMPTY_CONTENT;
    const notice = { ...section(base.notice), ...section(source.notice) };
    notice.roadmap = { ...section(base.notice?.roadmap), ...section(source.notice?.roadmap) };
    if (!source.notice && (source.announcement || source.announcementTitle)) {
      notice.enabled = true;
      notice.title = source.announcementTitle || notice.title;
      notice.body = source.announcement || notice.body;
    }
    return {
      notice,
      coop: { ...section(base.coop), ...section(source.coop) },
      rating: { ...section(base.rating), ...section(source.rating) }
    };
  }

  function httpsUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function pickRatingUrl(rating, store) {
    const data = section(rating);
    return httpsUrl(data[store]) || httpsUrl(data.edge) || httpsUrl(data.url);
  }

  function compareVersions(left, right) {
    const a = String(left || '').split('.').map((part) => Number(part) || 0);
    const b = String(right || '').split('.').map((part) => Number(part) || 0);
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
    }
    return 0;
  }

  function ratingEnabled(rating, version, store) {
    const data = section(rating);
    if (data.enabled !== true || !pickRatingUrl(data, store)) return false;
    return !data.minimumVersion || compareVersions(version, data.minimumVersion) >= 0;
  }

  function createConfigMessageHandler(options) {
    const opts = options || {};
    const expectedUrl = String(opts.configUrl || '');
    const expectedType = String(opts.messageType || 'DOWNLOAD_KIT_FETCH_CONFIG');
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    return function configMessageHandler(message, _sender, respond) {
      if (message?.type !== expectedType) return undefined;
      if (String(message.url || '') !== expectedUrl) {
        respond({ ok: false, error: '不允许的地址' });
        return undefined;
      }
      fetchImpl(expectedUrl, { cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then((data) => respond({ ok: true, data }))
        .catch((error) => respond({ ok: false, error: String(error?.message || error) }));
      return true;
    };
  }

  async function loadRemoteContent(options) {
    const opts = options || {};
    const runtime = opts.runtime;
    if (!runtime) throw new Error('runtime helper is required');
    const cacheKey = opts.cacheKey || 'downloadKitRemoteContent';
    try {
      const response = await runtime.sendMessage({ type: opts.messageType, url: opts.configUrl }, opts.api);
      if (response?.ok && response.data && typeof response.data === 'object') {
        const data = mergeRemoteContent(response.data, opts.defaults);
        await runtime.storageSet({ [cacheKey]: { data, updatedAt: Date.now() } }, opts.api);
        return data;
      }
    } catch (_) {}
    try {
      const cached = await runtime.storageGet(cacheKey, opts.api);
      return mergeRemoteContent(cached?.[cacheKey]?.data, opts.defaults);
    } catch (_) {
      return mergeRemoteContent({}, opts.defaults);
    }
  }

  return {
    EMPTY_CONTENT,
    mergeRemoteContent,
    httpsUrl,
    pickRatingUrl,
    compareVersions,
    ratingEnabled,
    createConfigMessageHandler,
    loadRemoteContent
  };
});
