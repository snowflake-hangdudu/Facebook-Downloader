(function initRuntime(root, factory) {
  const api = factory();
  root.DownloaderKit = root.DownloaderKit || {};
  root.DownloaderKit.runtime = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function runtimeFactory() {
  function getApi(scope) {
    const owner = scope || globalThis;
    const api = owner.browser || owner.chrome;
    if (!api) throw new Error('Extension API is unavailable');
    return api;
  }

  function invoke(method, context, args) {
    if (typeof method !== 'function') return Promise.reject(new Error('Extension API method is unavailable'));
    try {
      const result = method.apply(context, args || []);
      if (result && typeof result.then === 'function') return result;
      if (result !== undefined) return Promise.resolve(result);
    } catch (_) {}

    return new Promise((resolve, reject) => {
      try {
        method.apply(context, [...(args || []), (value) => {
          const runtime = globalThis.chrome?.runtime;
          if (runtime?.lastError) reject(new Error(runtime.lastError.message));
          else resolve(value);
        }]);
      } catch (error) {
        reject(error);
      }
    });
  }

  function storageGet(keys, api) {
    const ext = api || getApi();
    return invoke(ext.storage?.local?.get, ext.storage?.local, [keys]);
  }

  function storageSet(value, api) {
    const ext = api || getApi();
    return invoke(ext.storage?.local?.set, ext.storage?.local, [value]);
  }

  function sendMessage(message, api) {
    const ext = api || getApi();
    return invoke(ext.runtime?.sendMessage, ext.runtime, [message]);
  }

  function getVersion(api) {
    const ext = api || getApi();
    return String(ext.runtime?.getManifest?.().version || '0.0.0');
  }

  function detectStore(userAgent) {
    const ua = String(userAgent || globalThis.navigator?.userAgent || '');
    if (/Firefox\//i.test(ua)) return 'firefox';
    if (/Edg\//i.test(ua)) return 'edge';
    return 'chrome';
  }

  function isHttpsUrl(value) {
    try {
      return new URL(String(value || '')).protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  function isStoreBuild(api) {
    try {
      return Boolean((api || getApi()).runtime?.getManifest?.()?.update_url);
    } catch (_) {
      return false;
    }
  }

  return { getApi, invoke, storageGet, storageSet, sendMessage, getVersion, detectStore, isHttpsUrl, isStoreBuild };
});
