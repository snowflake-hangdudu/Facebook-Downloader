(function initDownloadThemes(root, factory) {
  const api = factory();
  root.DownloaderKit = root.DownloaderKit || {};
  root.DownloaderKit.theme = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function themeFactory() {
  const THEME_ID = /^[a-z][a-z0-9-]{0,40}$/;
  const FACEBOOK = {
    id: 'default',
    name: '平台默认',
    mode: 'light',
    colors: {
      background: '#F3F6FB',
      surface: 'rgba(255, 255, 255, 0.78)',
      surfaceHover: 'rgba(255, 255, 255, 0.88)',
      surfaceStrong: 'rgba(232, 240, 252, 0.90)',
      border: 'rgba(8, 102, 255, 0.16)',
      borderSoft: 'rgba(5, 5, 5, 0.08)',
      textPrimary: '#050505',
      textSecondary: '#65676B',
      textMuted: '#8A8D91',
      primary: '#0866FF',
      primaryStrong: '#0064E0',
      primaryHover: '#0654D4',
      primarySoft: 'rgba(231, 243, 255, 0.78)',
      primaryBorder: 'rgba(8, 102, 255, 0.28)',
      accent: '#0866FF',
      accentSecondary: '#1877F2'
    },
    gradients: {
      background: 'radial-gradient(circle at 8% 0%, rgba(8, 102, 255, 0.18) 0%, transparent 36%), radial-gradient(circle at 92% 16%, rgba(24, 119, 242, 0.12) 0%, transparent 32%), radial-gradient(circle at 48% 100%, rgba(8, 102, 255, 0.08) 0%, transparent 40%)',
      primaryButton: 'linear-gradient(180deg, #1877F2 0%, #0866FF 100%)',
      preview: 'radial-gradient(circle at 16% 18%, rgba(8, 102, 255, 0.55) 0%, transparent 32%), radial-gradient(circle at 82% 78%, rgba(24, 119, 242, 0.28) 0%, transparent 36%), linear-gradient(135deg, #F7FAFF 0%, #E7F0FF 58%, #D6E6FF 100%)',
      header: 'linear-gradient(90deg, rgba(8, 102, 255, 0.16) 0%, rgba(24, 119, 242, 0.08) 52%, rgba(255,255,255,0) 100%)'
    },
    effects: {
      surfaceBlur: '14px',
      headerBlur: '16px',
      noiseOpacity: 0.025,
      shadow: '0 10px 30px rgba(8, 40, 90, 0.08)'
    }
  };

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

  function variablesFor(theme) {
    const colors = theme.colors || {};
    const gradients = theme.gradients || {};
    const effects = theme.effects || {};
    return {
      '--theme-background': colors.background,
      '--theme-surface': colors.surface,
      '--theme-surface-hover': colors.surfaceHover,
      '--theme-surface-strong': colors.surfaceStrong,
      '--theme-border': colors.border,
      '--theme-border-soft': colors.borderSoft,
      '--theme-text-primary': colors.textPrimary,
      '--theme-text-secondary': colors.textSecondary,
      '--theme-text-muted': colors.textMuted,
      '--theme-primary': colors.primary,
      '--theme-primary-strong': colors.primaryStrong,
      '--theme-primary-hover': colors.primaryHover,
      '--theme-primary-soft': colors.primarySoft,
      '--theme-primary-border': colors.primaryBorder,
      '--theme-accent': colors.accent,
      '--theme-accent-secondary': colors.accentSecondary,
      '--theme-gradient-background': gradients.background || 'none',
      '--theme-gradient-button': gradients.primaryButton,
      '--theme-gradient-preview': gradients.preview,
      '--theme-gradient-header': gradients.header,
      '--theme-surface-blur': effects.surfaceBlur || '0px',
      '--theme-header-blur': effects.headerBlur || '0px',
      '--theme-noise-opacity': String(effects.noiseOpacity ?? 0),
      '--theme-shadow': effects.shadow,
      '--bg': colors.background,
      '--surface': colors.surface,
      '--surface-hover': colors.surfaceHover,
      '--surface-strong': colors.surfaceStrong,
      '--border': colors.border,
      '--border-soft': colors.borderSoft,
      '--text-primary': colors.textPrimary,
      '--text-secondary': colors.textSecondary,
      '--text-muted': colors.textMuted,
      '--footer-text': colors.textMuted,
      '--brand': colors.primary,
      '--brand-strong': colors.primaryStrong,
      '--brand-hover': colors.primaryHover,
      '--brand-soft': colors.primarySoft,
      '--brand-border': colors.primaryBorder,
      '--brand-cta': gradients.primaryButton,
      '--brand-header': gradients.header,
      '--brand-header-opacity': '1',
      '--brand-preview': gradients.preview,
      '--brand-accent': colors.accent,
      '--dl-bg': colors.background,
      '--dl-surface': colors.surface,
      '--dl-border': colors.border,
      '--dl-text': colors.textPrimary,
      '--dl-text-secondary': colors.textSecondary,
      '--dl-text-muted': colors.textMuted,
      '--dl-header-text': colors.textPrimary,
      '--dl-primary': colors.primary,
      '--dl-primary-strong': colors.primaryStrong,
      '--dl-primary-hover': colors.primaryHover,
      '--dl-primary-soft': colors.primarySoft,
      '--dl-primary-border': colors.primaryBorder,
      '--dl-primary-contrast': '#ffffff',
      '--dl-accent': colors.primary,
      '--dl-shadow': effects.shadow
    };
  }

  function paintElement(element, theme, fallbackTheme) {
    if (!element?.dataset || !element.style) return;
    const record = theme || FACEBOOK;
    element.dataset.theme = record.id === 'default' ? (fallbackTheme || 'facebook') : record.id;
    element.dataset.themeMode = record.mode === 'light' ? 'light' : 'dark';
    const vars = variablesFor(record);
    for (const key of Object.keys(vars)) {
      const value = vars[key];
      if (value == null || value === '') element.style.removeProperty(key);
      else element.style.setProperty(key, String(value));
    }
  }

  function createController(options) {
    const opts = options || {};
    const api = globalThis.DownloaderKit?.runtime?.getApi?.();
    const storage = api?.storage?.local;
    const storageKey = String(opts.storageKey || 'downloadKitTheme_v1');
    const fallback = String(opts.fallbackTheme || 'facebook');
    const roots = new Set();
    let catalog = [];
    let selected = 'default';

    function isAvailable(value) {
      return value === 'default' || catalog.some((theme) => theme.id === value);
    }

    function recordFor(id) {
      if (!id || id === 'default') return FACEBOOK;
      return catalog.find((theme) => theme.id === id) || FACEBOOK;
    }

    function apply(rootElement) {
      paintElement(rootElement, recordFor(selected), fallback);
    }

    function applyAll() {
      for (const element of roots) apply(element);
      const entries = globalThis.document?.querySelectorAll?.('.x-dl-post-entry');
      if (!entries) return;
      for (const entry of entries) {
        if (!roots.has(entry)) apply(entry);
      }
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
      return [{ id: 'default', name: FACEBOOK.name }, ...catalog.map(({ id, name }) => ({ id, name }))];
    }

    return {
      ready,
      list,
      current: () => selected,
      preview: (id) => recordFor(id === 'facebook' ? 'default' : id).gradients?.preview || '',
      paint: (element) => apply(element),
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
