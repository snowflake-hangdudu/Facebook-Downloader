(function initPanel(root, factory) {
  const api = factory();
  root.DownloaderKit = root.DownloaderKit || {};
  root.DownloaderKit.panel = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function panelFactory() {
  function create(options) {
    const opts = options || {};
    const doc = opts.document || globalThis.document;
    if (!doc?.body) throw new Error('document.body is required');
    const dom = opts.dom || globalThis.DownloaderKit?.dom;
    if (!dom) throw new Error('DownloaderKit.dom is required');

    const idPrefix = opts.idPrefix || 'dl-kit';
    function t(key, values) {
      return globalThis.DownloaderKit?.i18n?.t?.(key, values) || key;
    }
    const title = opts.title || t('downloaderFallback');
    const iconUrl = String(opts.iconUrl || '');
    const footer = opts.footer || {};

    const rootEl = doc.createElement('div');
    rootEl.className = 'dl-kit';
    rootEl.id = idPrefix + '-root';
    rootEl.dataset.theme = opts.theme || 'default';

    const wrap = doc.createElement('div');
    wrap.className = 'dl-kit-panel';
    wrap.id = idPrefix + '-panel';

    const fab = doc.createElement('button');
    fab.type = 'button';
    fab.className = 'dl-kit-toggle';
    fab.id = idPrefix + '-toggle';
    fab.title = title;
    fab.setAttribute('aria-expanded', 'false');
    if (iconUrl) {
      const icon = doc.createElement('img');
      icon.src = iconUrl;
      icon.alt = '';
      fab.appendChild(icon);
    } else {
      fab.textContent = opts.fabLabel || t('save');
    }

    const menu = doc.createElement('div');
    menu.className = 'dl-kit-menu hidden';
    menu.id = idPrefix + '-menu';
    menu.setAttribute('aria-label', title);
    menu.setAttribute('role', 'region');
    fab.setAttribute('aria-controls', menu.id);

    const header = doc.createElement('div');
    header.className = 'dl-kit-header';
    const headerLeft = doc.createElement('div');
    headerLeft.className = 'dl-kit-header-left';
    if (iconUrl) {
      const headerIcon = doc.createElement('img');
      headerIcon.className = 'dl-kit-header-icon';
      headerIcon.src = iconUrl;
      headerIcon.width = 30;
      headerIcon.height = 30;
      headerIcon.alt = '';
      headerLeft.appendChild(headerIcon);
    }
    dom.appendTextElement(headerLeft, 'span', 'dl-kit-title', title);
    headerLeft.querySelector('.dl-kit-title')?.setAttribute('data-i18n', 'appTitle');
    const version = dom.appendTextElement(headerLeft, 'span', 'dl-kit-version', opts.version ? 'v' + opts.version : '');
    if (!opts.version) version.hidden = true;
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'dl-kit-close';
    close.id = idPrefix + '-close';
    close.setAttribute('aria-label', t('close'));
    close.setAttribute('data-i18n-aria', 'close');
    close.textContent = '×';
    header.append(headerLeft, close);

    const body = doc.createElement('div');
    body.className = 'dl-kit-body';
    const home = doc.createElement('div');
    home.className = 'dl-kit-home';
    home.id = idPrefix + '-home';
    const page = doc.createElement('div');
    page.className = 'dl-kit-page hidden';
    page.id = idPrefix + '-page';

    const pageBack = doc.createElement('button');
    pageBack.type = 'button';
    pageBack.className = 'dl-kit-page-back';
    pageBack.dataset.i18n = 'backToDownload';
    pageBack.textContent = opts.backLabel || t('backToDownload');
    const pageTitle = dom.appendTextElement(page, 'div', 'dl-kit-page-title', '');
    pageTitle.id = idPrefix + '-info-title';
    const pageDate = dom.appendTextElement(page, 'div', 'dl-kit-info-date', '');
    pageDate.id = idPrefix + '-info-date';
    pageDate.hidden = true;
    const pageBody = doc.createElement('div');
    pageBody.className = 'dl-kit-info-body';
    pageBody.id = idPrefix + '-info-body';
    page.prepend(pageBack);
    page.append(pageTitle, pageDate, pageBody);

    let debugEl = null;
    if (opts.showDebug) {
      debugEl = doc.createElement('details');
      debugEl.className = 'dl-kit-debug';
      debugEl.id = idPrefix + '-debug';
      debugEl.open = false;
      const summary = doc.createElement('summary');
      summary.className = 'dl-kit-debug-summary';
      dom.appendTextElement(summary, 'span', '', t('debugLog'));
      const debugCount = dom.appendTextElement(summary, 'span', 'dl-kit-debug-count', '0');
      debugCount.id = idPrefix + '-debug-count';
      const debugActions = doc.createElement('div');
      debugActions.className = 'dl-kit-debug-actions';
      const debugCopy = doc.createElement('button');
      debugCopy.type = 'button';
      debugCopy.id = idPrefix + '-debug-copy';
      debugCopy.className = 'dl-kit-debug-btn';
      debugCopy.textContent = t('copy');
      const debugClear = doc.createElement('button');
      debugClear.type = 'button';
      debugClear.id = idPrefix + '-debug-clear';
      debugClear.className = 'dl-kit-debug-btn';
      debugClear.textContent = t('clearLog');
      debugActions.append(debugCopy, debugClear);
      const debugLog = doc.createElement('pre');
      debugLog.id = idPrefix + '-debug-log';
      debugLog.className = 'dl-kit-debug-log';
      debugEl.append(summary, debugActions, debugLog);
    }

    body.append(home);
    if (debugEl) body.append(debugEl);

    const rating = doc.createElement('div');
    rating.className = 'dl-kit-store-rating hidden';
    rating.id = idPrefix + '-store-rating';
    rating.setAttribute('role', 'note');
    dom.appendTextElement(rating, 'div', 'dl-kit-store-rating-title', t('ratingTitle'));
    const ratingText = dom.appendTextElement(rating, 'div', 'dl-kit-store-rating-text', t('ratingPrompt', { store: '' }).replace(/\s{2,}/g, ' '));
    const ratingPrimary = doc.createElement('button');
    ratingPrimary.type = 'button';
    ratingPrimary.className = 'dl-kit-store-rating-primary';
    ratingPrimary.dataset.action = 'rate';
    ratingPrimary.textContent = t('ratingGo', { store: '' }).replace(/\s{2,}/g, ' ');
    const ratingActions = doc.createElement('div');
    ratingActions.className = 'dl-kit-store-rating-actions';
    const ratingLater = doc.createElement('button');
    ratingLater.type = 'button';
    ratingLater.className = 'dl-kit-store-rating-ghost';
    ratingLater.dataset.action = 'later';
    ratingLater.textContent = t('ratingLater');
    const ratingNever = doc.createElement('button');
    ratingNever.type = 'button';
    ratingNever.className = 'dl-kit-store-rating-ghost';
    ratingNever.dataset.action = 'never';
    ratingNever.textContent = t('ratingNever');
    ratingActions.append(ratingLater, ratingNever);
    rating.append(ratingPrimary, ratingActions);

    const ICONS = {
      notice: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11v2a1 1 0 0 0 1 1h1l6 4V6L5 10H4a1 1 0 0 0-1 1z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
      settings: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="11" cy="18" r="2"/></svg>',
      feedback: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    };

    function sheetLink(key, label) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'dl-kit-footer-link';
      btn.dataset.sheet = key;
      btn.textContent = label;
      return btn;
    }

    function footerAction(key, label, icon) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'dl-kit-footer-action';
      if (key) btn.dataset.sheet = key;
      if (icon) btn.insertAdjacentHTML('afterbegin', icon);
      const text = doc.createElement('span');
      text.className = 'dl-kit-footer-label';
      text.textContent = label;
      if (key === 'notice') text.dataset.i18n = 'notice';
      if (key === 'settings') text.dataset.i18n = 'settings';
      btn.appendChild(text);
      return btn;
    }

    function externalLink(href, label) {
      const a = doc.createElement('a');
      a.className = footer.variant === 'actions' ? 'dl-kit-footer-action' : 'dl-kit-footer-link';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      if (footer.variant === 'actions') {
        const text = doc.createElement('span');
        text.className = 'dl-kit-footer-label';
        text.textContent = label;
        a.appendChild(text);
      } else {
        a.textContent = label;
      }
      if (href) dom.safeExternalLink(a, href);
      return a;
    }

    const footerEl = doc.createElement('div');
    footerEl.className = 'dl-kit-footer' + (footer.variant === 'actions' ? ' is-actions' : '');
    const links = doc.createElement('div');
    links.className = 'dl-kit-footer-links';
    const email = footer.email || 'hangdudu0@agent.qq.com';
    const subject = footer.subject || t('feedbackSubject');
    let themeLink = null;
    if (footer.variant === 'actions') {
      const settingsLink = footerAction('settings', footer.settingsLabel || t('settings'), ICONS.settings);
      const feedback = doc.createElement('button');
      feedback.type = 'button';
      feedback.className = 'dl-kit-footer-action dl-kit-feedback';
      feedback.dataset.feedbackEmail = email;
      feedback.dataset.i18nTitle = 'copyEmail';
      feedback.insertAdjacentHTML('afterbegin', ICONS.feedback);
      const feedbackLabel = doc.createElement('span');
      feedbackLabel.className = 'dl-kit-feedback-label';
      feedbackLabel.dataset.i18n = 'feedback';
      feedbackLabel.textContent = footer.feedbackShortLabel || t('feedback');
      feedback.appendChild(feedbackLabel);
      if (footer.showNotice !== false) {
        links.append(footerAction('notice', footer.noticeLabel || t('notice'), ICONS.notice));
      }
      if (footer.showSettings !== false) links.append(settingsLink);
      if (footer.showHelpLinks === true) {
        links.append(externalLink(footer.faqUrl, footer.faqLabel || t('faq')));
        links.append(externalLink(footer.privacyUrl, footer.privacyLabel || t('privacy')));
      }
      links.append(feedback);
    } else {
      const faqLink = externalLink(footer.faqUrl, footer.faqLabel || t('faq'));
      const privacyLink = externalLink(footer.privacyUrl, footer.privacyLabel || t('privacy'));
      const noticeLink = sheetLink('notice', footer.noticeLabel || t('notice'));
      const coopLink = sheetLink('coop', footer.coopLabel || t('coopTitle'));
      const settingsLink = sheetLink('settings', t('settings'));
      const tasksLink = sheetLink('tasks', t('tasksCenter'));
      const diagnosticsLink = sheetLink('diagnostics', t('diagnostics'));
      tasksLink.hidden = !opts.tasksEnabled;
      themeLink = doc.createElement('button');
      themeLink.type = 'button';
      themeLink.className = 'dl-kit-footer-link dl-kit-theme-link';
      themeLink.textContent = footer.themeLabel || t('theme');
      const feedback = doc.createElement('a');
      feedback.className = 'dl-kit-feedback';
      feedback.textContent = (footer.feedbackLabel || t('feedbackMailbox')) + email;
      dom.safeExternalLink(feedback, 'mailto:' + email + '?subject=' + encodeURIComponent(subject));
      if (footer.showNotice !== false) links.append(noticeLink);
      links.append(coopLink, settingsLink, tasksLink);
      if (footer.showDiagnostics !== false) links.append(diagnosticsLink);
      if (footer.showHelpLinks !== false) links.append(faqLink, privacyLink);
      links.append(feedback);
    }
    footerEl.append(links);

    menu.append(header, body, page, rating, footerEl);
    wrap.append(fab, menu);
    rootEl.appendChild(wrap);

    function isOpen() {
      return !menu.classList.contains('hidden');
    }

    function open() {
      const wasClosed = !isOpen();
      menu.classList.remove('hidden');
      fab.setAttribute('aria-expanded', 'true');
      if (wasClosed) close.focus({ preventScroll: true });
    }

    function hide() {
      menu.classList.add('hidden');
      fab.setAttribute('aria-expanded', 'false');
      showHome();
      fab.focus({ preventScroll: true });
    }

    function toggle() {
      if (isOpen()) hide();
      else open();
    }

    function showHome() {
      page.classList.add('hidden');
      body.classList.remove('hidden');
      home.classList.remove('hidden');
      menu.classList.remove('is-page');
      opts.onShowHome?.();
    }

    function openSheet(key, item) {
      const data = item || {};
      pageTitle.textContent = data.title || (key === 'coop' ? t('coopTitle') : t('notice'));
      if (data.subtitle) {
        pageDate.textContent = data.subtitle;
        pageDate.hidden = false;
      } else if (data.updated) {
        pageDate.textContent = t('updatedAt', { date: data.updated });
        pageDate.hidden = false;
      } else {
        pageDate.textContent = '';
        pageDate.hidden = true;
      }
      dom.clearNode(pageBody);
      if (typeof opts.onFillSheet === 'function') opts.onFillSheet(pageBody, key, data);
      else dom.fillTextLines(pageBody, data.body || t('emptyContent'));
      body.classList.add('hidden');
      home.classList.add('hidden');
      page.classList.remove('hidden');
      menu.classList.add('is-page');
      open();
      page.scrollTop = 0;
      pageBack.focus({ preventScroll: true });
    }

    function openThemeSettings() {
      pageTitle.textContent = t('appearance');
      pageDate.textContent = '';
      pageDate.hidden = true;
      dom.clearNode(pageBody);

      const setting = doc.createElement('label');
      setting.className = 'dl-kit-theme-setting';
      const copy = doc.createElement('span');
      copy.className = 'dl-kit-theme-setting-copy';
      dom.appendTextElement(copy, 'strong', '', t('theme'));
      dom.appendTextElement(copy, 'small', '', t('themeSyncHint'));
      const select = doc.createElement('select');
      select.className = 'dl-kit-theme-select';
      select.setAttribute('aria-label', t('chooseTheme'));
      const status = dom.appendTextElement(pageBody, 'p', 'dl-kit-theme-status', '');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      setting.append(copy, select);
      pageBody.append(setting);

      const updateOptions = () => {
        const catalog = opts.themeController?.list?.() || [{ id: 'default', name: t('defaultTheme') }];
        select.replaceChildren(...catalog.map((theme) => {
          const option = doc.createElement('option');
          option.value = theme.id;
          option.textContent = theme.name;
          return option;
        }));
        select.value = opts.themeController?.current?.() || 'default';
      };
      updateOptions();
      opts.themeController?.ready?.then(updateOptions);
      select.addEventListener('change', async () => {
        if (!opts.themeController) return;
        select.disabled = true;
        status.textContent = t('saving');
        try {
          await opts.themeController.set(select.value);
          status.textContent = t('themeSavedPeriod');
        } catch (_) {
          select.value = opts.themeController.current();
          status.textContent = t('saveRetry');
        } finally {
          select.disabled = false;
        }
      });

      body.classList.add('hidden');
      home.classList.add('hidden');
      page.classList.remove('hidden');
      menu.classList.add('is-page');
      open();
      page.scrollTop = 0;
      select.focus();
    }

    function setSheetEnabled(key, enabled) {
      footerEl.querySelectorAll('[data-sheet="' + key + '"]').forEach((el) => {
        el.hidden = !enabled;
      });
    }

    function setRating(state) {
      const next = state || {};
      const label = next.storeLabel || 'Edge';
      ratingText.textContent = t('ratingPrompt', { store: label });
      ratingPrimary.textContent = t('ratingGo', { store: label });
      rating.classList.toggle('hidden', !next.visible);
    }

    fab.addEventListener('click', toggle);
    close.addEventListener('click', hide);
    pageBack.addEventListener('click', showHome);
    footerEl.querySelectorAll('[data-sheet]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        opts.onOpenSheet?.(btn.dataset.sheet);
      });
    });
    themeLink?.addEventListener('click', openThemeSettings);
    footerEl.querySelector('.dl-kit-feedback[data-feedback-email]')?.addEventListener('click', (event) => {
      event.preventDefault();
      const button = event.currentTarget;
      opts.onFeedback?.(button.dataset.feedbackEmail, button);
    });
    function onKeydown(event) {
      if (event.key === 'Escape' && isOpen()) {
        event.preventDefault();
        if (menu.classList.contains('is-page')) { showHome(); close.focus({ preventScroll: true }); }
        else hide();
      }
    }
    doc.addEventListener('keydown', onKeydown);
    rating.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => opts.onRatingAction?.(btn.dataset.action));
    });
    doc.body.appendChild(rootEl);

    return {
      root: rootEl,
      home,
      open,
      hide,
      toggle,
      isOpen,
      showHome,
      openSheet,
      setSheetEnabled,
      setRating,
      openThemeSettings,
      destroy: () => { doc.removeEventListener('keydown', onKeydown); rootEl.remove(); }
    };
  }

  return { create };
});
