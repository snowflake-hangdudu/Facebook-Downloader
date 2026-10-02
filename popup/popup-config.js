function t(key, values) {
  return globalThis.DownloaderKit?.i18n?.t?.(key, values) || key;
}

window.DOWNLOADER_POPUP_CONFIG = {
  title: 'Facebook Downloader',
  theme: 'facebook',
  initialTheme: 'default',
  themeKey: 'facebook-dl-theme-v1',
  getInfoType: 'FACEBOOK_DL_GET_INFO',
  openPanelType: 'FACEBOOK_DL_OPEN_PANEL',
  faqUrl: 'https://snowflake-hangdudu.github.io/Facebook-Downloader/faq.html',
  privacyUrl: 'https://snowflake-hangdudu.github.io/Facebook-Downloader/',
  isSiteUrl(value) {
    try {
      const host = new URL(value).hostname;
      return /(^|\.)facebook\.com$/i.test(host) || /(^|\.)fb\.watch$/i.test(host);
    } catch (_) { return false; }
  },
  isContentUrl(value) {
    try {
      const url = new URL(value);
      const host = url.hostname;
      if (!/(^|\.)facebook\.com$/i.test(host) && !/(^|\.)fb\.watch$/i.test(host)) return false;
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (path === '/' || /\/home\.php$/i.test(path)) return true;
      if (/^\/watch(?:\/|$)/i.test(path) || /^\/reels?(?:\/|$)/i.test(path)) return true;
      if (/\/(?:posts|videos|photos|reel|reels)\//i.test(path)) return true;
      if (/^\/(?:photo|permalink|story|profile)\.php/i.test(path)) return true;
      if (/^\/share\//i.test(path) || /^\/groups\/[^/]+/i.test(path) || /^\/stories\//i.test(path)) return true;
      if (/^\/[^/]+(?:\/(?:photos|photos_by|videos|reels_tab|reels))?$/i.test(path)) return true;
      return false;
    } catch (_) { return false; }
  },
  renderReady(info, elements) {
    elements.title.textContent = info.title || 'Facebook';
    const authorName = String(info.author || '').replace(/^@/, '').trim();
    elements.author.textContent = authorName;
    elements.author.dataset.prefix = authorName ? t('authorLabel') + ' · ' : '';
    elements.author.classList.toggle('hidden', !authorName);
    elements.sub.textContent = info.sub || (info.mediaCount ? t('mediaCount', { count: info.mediaCount }) : '');
    if (info.cover && /^https:\/\//i.test(info.cover)) {
      elements.cover.src = info.cover;
      elements.cover.referrerPolicy = 'no-referrer';
      elements.cover.onload = () => {
        elements.cover.classList.remove('hidden');
        elements.coverPh.classList.add('hidden');
      };
      elements.cover.onerror = () => {
        elements.cover.classList.add('hidden');
        elements.coverPh.classList.remove('hidden');
      };
    } else {
      elements.cover.classList.add('hidden');
      elements.coverPh.classList.remove('hidden');
    }
    const tags = elements.qualities;
    if (tags) {
      tags.replaceChildren();
      const labels = Array.isArray(info.qualities) && info.qualities.length ? info.qualities : [];
      if (labels.length) {
        labels.forEach((label, index) => {
          const tag = document.createElement('span');
          tag.className = 'popup-q-tag' + (index === 0 ? ' best' : '');
          tag.textContent = label;
          tags.appendChild(tag);
        });
      } else {
        const tag = document.createElement('span');
        tag.className = 'popup-q-tag';
        tag.textContent = info.mode === 'creator' ? t('profileBatch') : (info.sub || t('currentContent'));
        tags.appendChild(tag);
      }
    }
    const open = document.getElementById('btn-open-panel');
    if (open) open.disabled = false;
  },
  readyTips: [
    'Nothing downloads until you start it',
    'Use the page panel for carousel selection, queue, history, and theme'
  ],
  empty: {
    homeUrl: 'https://www.facebook.com/',
    homeLabel: 'Open Facebook'
  },
  error: {}
};
