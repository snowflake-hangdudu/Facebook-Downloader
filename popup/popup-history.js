(function initPopupHistory() {
  const api = globalThis.browser || globalThis.chrome;
  const toggle = document.getElementById('popup-history-toggle');
  const panel = document.getElementById('popup-history-panel');
  const list = document.getElementById('popup-history-list');
  const count = document.getElementById('popup-history-count');
  const clear = document.getElementById('popup-history-clear');
  if (!api?.runtime || !toggle || !panel || !list) return;

  function date(value) {
    const parsed = new Date(Number(value) || value || 0);
    return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString() : '';
  }

  function send(message) {
    return globalThis.DownloaderKit.runtime.sendMessage(message, api);
  }

  async function load() {
    const result = await send({ type: 'FACEBOOK_DL_HISTORY_LIST' }).catch(() => ({}));
    const history = Array.isArray(result.history) ? result.history : [];
    count.textContent = String(history.length);
    count.classList.toggle('hidden', !history.length);
    list.replaceChildren();
    if (!history.length) {
      const empty = document.createElement('p');
      empty.className = 'popup-history-empty';
      empty.textContent = t('historyEmpty');
      list.appendChild(empty);
      clear.classList.add('hidden');
      return;
    }
    clear.classList.remove('hidden');
    history.slice(0, 6).forEach((entry) => {
      const row = document.createElement('article');
      row.className = 'popup-history-item';
      const main = document.createElement('div');
      main.className = 'popup-history-main';
      const title = document.createElement('strong');
      title.textContent = entry.title || t('facebookPost');
      const meta = document.createElement('span');
      meta.textContent = (entry.author ? '@' + entry.author + ' · ' : '') + (entry.type || 'video') + ' · ' + date(entry.time);
      main.append(title, meta);
      row.appendChild(main);
      const status = document.createElement('span');
      status.className = 'popup-history-status ' + (entry.status || '');
      status.textContent = entry.status === 'completed' ? t('historyDone') : entry.status === 'failed' ? t('historyFailed') : t('historyCancelled');
      row.appendChild(status);
      if (entry.pageUrl) {
        const link = document.createElement('a');
        link.href = entry.pageUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = t('historyOpen');
        link.className = 'popup-history-open';
        row.appendChild(link);
      }
      list.appendChild(row);
    });
  }

  toggle.addEventListener('click', async () => {
    const opening = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !opening);
    toggle.setAttribute('aria-expanded', String(opening));
    if (opening) await load();
  });
  clear.addEventListener('click', async () => {
    if (!globalThis.confirm(t('historyClearConfirm'))) return;
    await send({ type: 'FACEBOOK_DL_DATA_CLEAR', scope: 'history' }).catch(() => {});
    await load();
  });
  api.storage?.onChanged?.addListener?.((changes, area) => {
    if (area === 'local' && changes['facebook-dl-history-v1'] && !panel.classList.contains('hidden')) load();
  });
  const startHistory = () => load().catch(() => {});
  const i18nReady = globalThis.DownloaderKit?.i18n?.ready;
  if (i18nReady?.then) i18nReady.then(startHistory).catch(startHistory);
  else startHistory();
  globalThis.DownloaderKit?.i18n?.onChange?.(() => {
    if (!panel.classList.contains('hidden')) load().catch(() => {});
  });
})();
