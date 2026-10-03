const EXT = typeof browser !== 'undefined' ? browser : chrome;
const VERSION = EXT.runtime.getManifest().version;
const CONFIG = globalThis.DOWNLOADER_POPUP_CONFIG || {};
const $ = (id) => document.getElementById(id);

const copy = {
  en: { title: 'Facebook Downloader', statusFacebook: 'Facebook download guide', statusOther: 'Open Facebook first', heading: 'Download from Facebook', leadFacebook: 'Download from the home feed, post pages, Reels, or profiles.', leadOther: 'Download entries appear on Facebook posts, Reels, profiles, or beside feed posts.', stepOpen: 'Browse the home feed, or open a post, Reel, video, or profile', stepEntry: 'Click Download beside a feed post, or the floating entry on a post page', stepDownload: 'Choose items in Current content or Creator, then download', note: 'Home feed posts support individual downloads. Sponsored posts are hidden by default; turn this off in Settings. Post pages and profiles have a persistent entry.', open: 'Open Facebook', faq: 'FAQ', privacy: 'Privacy', help: 'Help links', steps: 'Download steps', disclaimer: 'For personal learning only. Follow Facebook’s terms.' },
  'zh-CN': { title: 'Facebook视频下载助手', statusFacebook: 'Facebook 下载步骤', statusOther: '请先打开 Facebook', heading: '在 Facebook 页面下载内容', leadFacebook: '首页、帖子详情、Reels 和个人主页均可下载。', leadOther: '下载入口会显示在 Facebook 帖子页、个人主页或信息流帖子旁。', stepOpen: '浏览首页，或打开帖子、Reel、视频、个人主页', stepEntry: '首页点击帖子旁“下载”；详情页点击悬浮入口', stepDownload: '在“当前内容”或“创作者”中选择并下载', note: '首页支持逐条下载。默认隐藏赞助内容，可在设置中关闭；详情页和个人主页提供常驻入口。', open: '打开 Facebook', faq: '常见问题', privacy: '隐私政策', help: '帮助链接', steps: '下载步骤', disclaimer: '仅供个人学习 · 请遵守 Facebook 使用条款' },
  'zh-TW': { title: 'Facebook影片下載助手', statusFacebook: 'Facebook 下載步驟', statusOther: '請先開啟 Facebook', heading: '在 Facebook 頁面下載內容', leadFacebook: '首頁、貼文詳情、Reels 和個人主頁均可下載。', leadOther: '下載入口會顯示在 Facebook 貼文頁、個人主頁或動態消息貼文旁。', stepOpen: '瀏覽首頁，或開啟貼文、Reel、影片、個人主頁', stepEntry: '首頁點選貼文旁「下載」；詳情頁點選浮動入口', stepDownload: '在「目前內容」或「創作者」中選擇並下載', note: '首頁支援逐則下載。預設隱藏贊助內容，可在設定中關閉；詳情頁和個人主頁提供常駐入口。', open: '開啟 Facebook', faq: '常見問題', privacy: '隱私權政策', help: '說明連結', steps: '下載步驟', disclaimer: '僅供個人學習 · 請遵守 Facebook 使用條款' }
};

function isFacebookUrl(value) {
  try {
    const host = new URL(value).hostname;
    return /(^|\.)facebook\.com$/i.test(host) || /(^|\.)fb\.watch$/i.test(host);
  } catch (_) { return false; }
}
function setText(id, value) { const element = $(id); if (element) element.textContent = value; }

async function init() {
  const themeController = globalThis.DownloaderKit?.theme?.createController({ storageKey: CONFIG.themeKey, fallbackTheme: CONFIG.theme, initialTheme: CONFIG.initialTheme });
  themeController?.attach(document.body);
  try { await globalThis.DownloaderKit?.i18n?.ready; } catch (_) {}
  const selectedLanguage = globalThis.DownloaderKit?.i18n?.language?.();
  const language = selectedLanguage === 'zh-CN' || selectedLanguage === 'zh-TW' ? selectedLanguage : 'en';
  const text = copy[language];
  document.documentElement.lang = language;
  setText('app-title', text.title); setText('guide-title', text.heading); setText('step-open', text.stepOpen); setText('step-entry', text.stepEntry); setText('step-download', text.stepDownload); setText('detail-note', text.note); setText('btn-go-site', text.open); setText('disclaimer', text.disclaimer); setText('app-version', 'v' + VERSION);
  document.querySelector('.popup-footer-links')?.setAttribute('aria-label', text.help);
  document.querySelector('.popup-steps')?.setAttribute('aria-label', text.steps);
  const links = document.querySelectorAll('.popup-footer-link');
  if (links[0]) links[0].textContent = text.faq;
  if (links[1]) links[1].textContent = text.privacy;
  let tab;
  try { [tab] = await EXT.tabs.query({ active: true, currentWindow: true }); } catch (_) {}
  const onFacebook = isFacebookUrl(tab?.url);
  setText('page-status', onFacebook ? text.statusFacebook : text.statusOther);
  setText('guide-lead', onFacebook ? text.leadFacebook : text.leadOther);
  $('btn-go-site').hidden = onFacebook;
}
init();
