(function initShell(root, factory) {
  const api = factory();
  root.DownloaderKit = root.DownloaderKit || {};
  root.DownloaderKit.shell = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function shellFactory() {
  function mount(options) {
    const opts = options || {};
    const kit = globalThis.DownloaderKit;
    const runtime = kit.runtime;
    const version = opts.version || runtime.getVersion();
    const api = runtime.getApi();
    const defaults = kit.remote.mergeRemoteContent({}, opts.defaults);
    let remoteContent = defaults;
    let currentSheet = '';
    let destroyed = false;
    const settings = kit.settings?.create({ storageKey: opts.settingsKey || (opts.idPrefix || 'downloadKit') + 'Settings_v1' });
    const showDebug = kit.debug.isEnabled(opts.showDebug, api);
    const themeController = kit.theme?.createController({
      storageKey: opts.themeKey,
      fallbackTheme: opts.theme,
      initialTheme: opts.initialTheme
    });

    const panel = kit.panel.create({
      title: opts.title,
      idPrefix: opts.idPrefix,
      theme: opts.theme,
      version,
      iconUrl: opts.iconUrl || api.runtime.getURL('icons/icon128.png'),
      fabLabel: opts.fabLabel,
      backLabel: opts.backLabel,
      footer: opts.footer,
      themeController,
      showDebug,
      tasksEnabled: Boolean(opts.tasks?.list),
      onOpenSheet: openSheet,
      onShowHome() { currentSheet = ''; },
      onFillSheet(body, key, data) {
        if (key === 'settings') {
          if (typeof opts.onFillSettings === 'function') opts.onFillSettings(body);
          else fillSettings(body);
        }
        else if (key === 'tasks') fillTasks(body);
        else if (key === 'diagnostics') fillDiagnostics(body);
        else if (key === 'notice') kit.notice.fillNoticeBody(body, data, { coop: remoteContent.coop });
        else kit.dom.fillTextLines(body, data.body || t('emptyContent'));
      },
      onFeedback: opts.onFeedback,
      onRatingAction: (action) => rating.handleAction(action)
    });
    themeController?.attach(panel.root);

    const debug = kit.debug.create({
      enabled: showDebug,
      idPrefix: opts.idPrefix,
      logTag: opts.debugTag || opts.title || 'DLKIT',
      api
    });
    debug.bind();

    const rating = kit.rating.createController({
      runtime,
      storageKey: opts.ratingKey || 'downloadKitStoreRating',
      getRating: () => remoteContent.rating,
      getVersion: () => version,
      onVisible(visible, storeLabel) {
        panel.setRating({ visible, storeLabel });
      }
    });

    async function loadRemote() {
      try {
        remoteContent = await kit.remote.loadRemoteContent({
          runtime,
          configUrl: opts.configUrl,
          messageType: opts.messageType,
          cacheKey: opts.cacheKey || 'downloadKitRemoteContent',
          defaults
        });
      } catch (_) {
        remoteContent = defaults;
      }
      if (!destroyed) applyRemoteButtons();
      return remoteContent;
    }

    function applyRemoteButtons() {
      panel.setSheetEnabled('notice', false);
      if (opts.footer?.showNotice !== false) {
        panel.setSheetEnabled('notice', remoteContent.notice?.enabled !== false);
      }
      panel.setSheetEnabled('coop', remoteContent.coop?.enabled !== false);
      if (!rating.enabled()) panel.setRating({ visible: false });
    }

    function t(key, values) {
      return (kit.i18n || globalThis.DownloaderKit?.i18n)?.t?.(key, values) || key;
    }

    function openSheet(key) {
      if (key === 'coop') key = 'notice';
      if (key === 'notice' && opts.footer?.showNotice === false) return;
      currentSheet = key;
      if (key === 'settings') {
        panel.openSheet(key, { title: t('settings'), subtitle: t('settingsHint') });
        return;
      }
      if (['tasks', 'diagnostics'].includes(key)) {
        panel.openSheet(key, { title: { tasks: t('tasksCenter'), diagnostics: t('diagnostics') }[key] });
        return;
      }
      panel.openSheet(key, remoteContent[key] || defaults[key]);
      loadRemote().then((data) => {
        if (!destroyed && currentSheet === key) panel.openSheet(key, data[key] || defaults[key]);
      });
    }

    function element(body, tag, text, className = '') {
      return kit.dom.appendTextElement(body, tag, className, text);
    }
    function fillSettings(body) {
      const appearance = element(body, 'button', t('chooseTheme'), 'dl-kit-action');
      appearance.type = 'button'; appearance.onclick = () => { currentSheet = 'theme'; panel.openThemeSettings(); };
      if (!settings) return;
      const label = element(body, 'label', t('filenameTemplate'), 'dl-kit-settings-field');
      const input = element(label, 'input', ''); input.type = 'text'; input.maxLength = 180;
      element(body, 'p', t('availableFields', { fields: settings.tokens.map(token => '{' + token + '}').join(' ') }), 'dl-kit-settings-hint');
      const preview = element(body, 'p', '', 'dl-kit-settings-preview');
      const status = element(body, 'p', '', 'dl-kit-settings-hint'); status.setAttribute('role', 'status');
      function refresh() {
        try { preview.textContent = kit.settings.filename(input.value, { title: t('sampleTitle'), author: t('sampleAuthor'), id: 'demo', quality: '1080P', index: 2 }, 'mp4'); status.textContent = ''; }
        catch (error) { status.textContent = error.message; preview.textContent = ''; }
      }
      settings.ready.then(() => { if (!destroyed && currentSheet === 'settings') { input.value = settings.current().filenameTemplate; refresh(); } }).catch(error => { status.textContent = error.message; });
      input.oninput = refresh;
      const save = element(body, 'button', t('saveSettings'), 'dl-kit-action'); save.type = 'button';
      const reset = element(body, 'button', t('resetFilename'), 'dl-kit-action'); reset.type = 'button';
      async function commit(isReset) {
        save.disabled = reset.disabled = true;
        try { const value = isReset ? await settings.reset() : await settings.save(input.value); input.value = value.filenameTemplate; refresh(); status.textContent = t('saved'); opts.onSettingsChanged?.(value); }
        catch (error) { status.textContent = error.message; }
        finally { save.disabled = reset.disabled = false; }
      }
      save.onclick = () => commit(false); reset.onclick = () => commit(true);
      opts.extendSettings?.(body, { element, settings, panel });
    }
    function fillTasks(body) {
      if (typeof opts.fillTasks === 'function') {
        opts.fillTasks(body, { element, tasks: opts.tasks, refresh: () => openSheet('tasks') });
        return;
      }
      const status = element(body, 'p', t('readingTasks'), 'dl-kit-settings-hint');
      Promise.resolve().then(() => opts.tasks?.list?.() || []).then(tasks => {
        if (destroyed || currentSheet !== 'tasks' || !status.isConnected) return;
        status.textContent = tasks.length ? '' : t('noTasks');
        const group = element(body, 'div', '', 'dl-kit-job-panel');
        tasks.forEach(task => {
          const row = element(group, 'div', '', 'dl-kit-job-card');
          element(row, 'strong', task.title || t('downloadTask'));
          element(row, 'p', String(task.status || task.state || ''), 'dl-kit-settings-hint');
          ['pause', 'resume', 'cancel', 'retry'].forEach(action => {
            if (!task.actions?.includes(action) || typeof opts.tasks[action] !== 'function') return;
            const button = element(row, 'button', { pause: t('pause'), resume: t('resume'), cancel: t('cancel'), retry: t('retryTask') }[action], 'dl-kit-action');
            button.type = 'button'; button.onclick = async () => {
              button.disabled = true;
              try { await opts.tasks[action](task.id); if (!destroyed && currentSheet === 'tasks') openSheet('tasks'); }
              catch (error) { status.textContent = error.message; button.disabled = false; }
            };
          });
        });
      }).catch(error => { status.textContent = error.message; });
    }
    function fillDiagnostics(body) {
      element(body, 'p', t('extVersion', { version }), 'dl-kit-settings-hint');
      element(body, 'p', remoteContent === defaults ? t('remoteCopyBuiltin') : t('remoteCopyLoaded'), 'dl-kit-settings-hint');
      element(body, 'p', t('currentTheme', { theme: themeController?.current?.() || 'default' }), 'dl-kit-settings-hint');
      if (opts.diagnostics) Promise.resolve().then(() => opts.diagnostics()).then(text => {
        if (!destroyed && currentSheet === 'diagnostics') element(body, 'pre', typeof text === 'string' ? text : JSON.stringify(text, null, 2), 'dl-kit-settings-preview');
      }).catch(error => { if (!destroyed && currentSheet === 'diagnostics') element(body, 'p', error.message); });
    }

    const messages = opts.messages || {};
    const onMessage = (message) => {
      if (message?.type === messages.openPanel || message?.type === 'DOWNLOADER_OPEN_PANEL') {
        panel.open();
        return undefined;
      }
      if (message?.type === messages.openSheet) {
        panel.open();
      if (message.sheet === 'settings') openSheet('settings');
        else if (opts.footer?.showNotice !== false) openSheet('notice');
      }
      return undefined;
    };
    api.runtime.onMessage.addListener(onMessage);

    loadRemote();

    return {
      panel,
      home: panel.home,
      debug,
      rating,
      settings,
      theme: themeController,
      loadRemote,
      noteSuccess: () => rating.noteSuccess(),
      open: () => panel.open(),
      hide: () => panel.hide(),
      showHome: () => panel.showHome(),
      openSheet,
      destroy: () => { destroyed = true; currentSheet = ''; api.runtime.onMessage.removeListener?.(onMessage); themeController?.destroy?.(); panel.destroy(); }
    };
  }

  return { mount };
});
