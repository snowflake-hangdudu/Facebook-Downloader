(function initRating(root, factory) {
  const api = factory();
  root.DownloaderKit = root.DownloaderKit || {};
  root.DownloaderKit.rating = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function ratingFactory() {
  const STORE_LABELS = { edge: 'Edge', chrome: 'Chrome', firefox: 'Firefox' };

  function createController(options) {
    const opts = options || {};
    const runtime = opts.runtime || globalThis.DownloaderKit?.runtime;
    const remote = opts.remote || globalThis.DownloaderKit?.remote;
    if (!runtime || !remote) throw new Error('DownloaderKit.runtime / remote is required');
    const storageKey = opts.storageKey || 'downloadKitStoreRating';
    const getRating = typeof opts.getRating === 'function' ? opts.getRating : () => ({});
    const getVersion = typeof opts.getVersion === 'function' ? opts.getVersion : () => runtime.getVersion();
    const onVisible = typeof opts.onVisible === 'function' ? opts.onVisible : () => {};

    function store() {
      return runtime.detectStore();
    }

    function url() {
      return remote.pickRatingUrl(getRating(), store());
    }

    function storeKey() {
      const rating = getRating() || {};
      const key = store();
      return remote.httpsUrl(rating[key]) ? key : 'edge';
    }

    function storeLabel() {
      return STORE_LABELS[storeKey()] || 'Edge';
    }

    function enabled() {
      return remote.ratingEnabled(getRating(), getVersion(), store());
    }

    function minSuccess() {
      const n = Number(getRating()?.minSuccess);
      return n > 0 ? n : 3;
    }

    async function loadState() {
      const stored = await runtime.storageGet(storageKey);
      const value = stored?.[storageKey];
      return value && typeof value === 'object' ? value : {};
    }

    async function saveState(patch) {
      const prev = await loadState();
      await runtime.storageSet({ [storageKey]: { ...prev, ...patch } });
    }

    async function noteSuccess() {
      if (!enabled()) {
        onVisible(false, storeLabel());
        return false;
      }
      const state = await loadState();
      if (state.neverAsk) {
        onVisible(false, storeLabel());
        return false;
      }
      const count = (Number(state.successCount) || 0) + 1;
      await saveState({ successCount: count, dismissedUntilNextSuccess: false });
      const show = count >= minSuccess();
      onVisible(show, storeLabel());
      return show;
    }

    async function handleAction(action) {
      if (action === 'rate') {
        onVisible(false, storeLabel());
        const href = url();
        if (href) globalThis.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      if (action === 'never') await saveState({ neverAsk: true });
      else await saveState({ dismissedUntilNextSuccess: true });
      onVisible(false, storeLabel());
    }

    function hide() {
      onVisible(false, storeLabel());
    }

    return { enabled, url, storeLabel, minSuccess, loadState, saveState, noteSuccess, handleAction, hide };
  }

  return { STORE_LABELS, createController };
});
