(function initDownloadThemes(root, factory) {
  const api = factory();
  root.DownloaderKit = root.DownloaderKit || {};
  root.DownloaderKit.theme = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function themeFactory() {
  const THEME_ID = /^[a-z][a-z0-9-]{0,40}$/;

  async function loadCatalog() {
    const api = globalThis.DownloaderKit?.runtime?.getApi?.();
    if (!api?.runtime?.getURL) return [];
    try {
      const response = await fetch(api.runtime.getURL('shared/themes.json'));
      if (!response.ok) return [];
      const data = await response.json();
      if (!Array.isArray(data?.themes)) return [];
      const seen = new Set();
      return data.themes.filter((theme) => {
        if (!theme || !THEME_ID.test(theme.id || '') || typeof theme.name !== 'string') return false;
        if (seen.has(theme.id) || !theme.colors || !theme.gradients) return false;
        seen.add(theme.id);
        return true;
      });
    } catch (_) {
      return [];
    }
  }

  function createController(options) {
    const opts = options || {};
    const api = globalThis.DownloaderKit?.runtime?.getApi?.();
    const storage = api?.storage?.local;
    const storageKey = String(opts.storageKey || 'downloadKitTheme_v1');
    const fallback = String(opts.fallbackTheme || 'default');
    const roots = new Set();
    let catalog = [];
    let selected = 'default';

    function isAvailable(value) {
      return value === 'default' || catalog.some((theme) => theme.id === value);
    }

    function apply(rootElement) {
      if (!rootElement?.dataset) return;
      rootElement.dataset.theme = selected === 'default' ? fallback : selected;
    }

    function applyAll() {
      for (const element of roots) apply(element);
    }

    async function set(value) {
      const next = isAvailable(value) ? value : 'default';
      const previous = selected;
      selected = next;
      applyAll();
      try {
        if (storage) await storage.set({ [storageKey]: selected });
      } catch (error) {
        selected = previous;
        applyAll();
        throw error;
      }
      return selected;
    }

    const ready = Promise.all([
      loadCatalog(),
      storage ? storage.get(storageKey) : Promise.resolve({})
    ]).then(([definitions, data]) => {
      catalog = definitions;
      const saved = data?.[storageKey];
      selected = isAvailable(saved) ? saved : 'default';
      applyAll();
      return { themes: list(), selected };
    }).catch(() => {
      catalog = [];
      selected = 'default';
      applyAll();
      return { themes: list(), selected };
    });

    const onStorageChanged = (changes, areaName) => {
      if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, storageKey)) return;
      const next = changes[storageKey]?.newValue;
      selected = isAvailable(next) ? next : 'default';
      applyAll();
    };
    api?.storage?.onChanged?.addListener?.(onStorageChanged);

    function list() {
      return [{ id: 'default', name: '平台默认' }, ...catalog.map(({ id, name }) => ({ id, name }))];
    }

    return {
      ready,
      list,
      current: () => selected,
      attach(element) {
        roots.add(element);
        apply(element);
        return () => roots.delete(element);
      },
      set,
      destroy() { api?.storage?.onChanged?.removeListener?.(onStorageChanged); roots.clear(); }
    };
  }

  return { loadCatalog, createController };
});
