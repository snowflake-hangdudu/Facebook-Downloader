(function bootFacebookDownloader() {
  'use strict';

  const EXT = DownloaderKit.runtime.getApi();
  const Model = globalThis.FacebookDownloaderModel;
  const PREFS_KEY = 'facebook-dl-settings-v1';
  const POSTS_KEY = 'facebook-dl-posts-v1';
  const SOURCE = 'facebook-downloader-page-agent';
  const CONTENT_SOURCE = 'facebook-downloader-content';
  const DEFAULT_PREFS = {
    imageQuality: 'highest',
    videoQuality: 'highest',
    maxConcurrentDownloads: 1,
    filenameTemplate: '{title} - {author}',
    skipDownloaded: true,
    recordHistory: true,
    showFloatingButton: true,
    hideAds: true,
    creatorFolders: false,
    carouselFolders: false
  };
  if (document.getElementById('facebook-dl-root')) return;

  let snapshot = { kind: 'unsupported', url: location.href };
  let prefs = { ...DEFAULT_PREFS };
  let activeMode = 'current';
  let selectedMedia = new Set();
  let mediaSelectionPost = '';
  let selectedPosts = new Set();
  let creatorPosts = new Map();
  let creatorKey = '';
  const creatorCaches = new Map();
  let creatorPreparing = false;
  let creatorPrepareToken = 0;
  let creatorAutoTimer = 0;
  let creatorScanToken = 0;
  let creatorScanning = false;
  let creatorUsernameDraft = '';
  let threadScanning = false;
  let threadScanToken = 0;
  async function downloadThread() {
    if (threadScanning || snapshot.kind !== 'post') return;
    const url = location.href;
    const token = ++threadScanToken;
    threadScanning = true;
    const collected = new Map();
    let stable = 0;
    let previousCount = -1;
    try {
      while (token === threadScanToken && location.href === url && collected.size < 1000) {
        (snapshot.threadPosts || []).forEach(post => collected.set(post.id, post));
        stable = collected.size === previousCount ? stable + 1 : 0;
        previousCount = collected.size;
        renderCurrent();
        if (stable >= 5) break;
        window.scrollTo({top: document.documentElement.scrollHeight, behavior: 'instant'});
        await new Promise(resolve => setTimeout(resolve, 1800));
      }
      if (token !== threadScanToken || location.href !== url) return;
      for (const post of [...collected.values()].sort((a,b) => String(a.publishTime).localeCompare(String(b.publishTime)))) {
        if (token !== threadScanToken || location.href !== url) break;
        await enqueueMedia(post, post.media, {queue:'current', respectSkipDownloaded: true});
      }
      if (!collected.size) setStatus(t('noResource'),'warn');
    } finally {
      if (token === threadScanToken) { threadScanning = false; renderView(); }
    }
  }
  const creatorFilters = { type: 'all', from: '', to: '', min: '', max: '', limit: '' };
  let savedMediaKeys = new Set();
  async function refreshSavedMarks() {
    savedMediaKeys = await completedKeys();
  }
  function filteredCreatorPosts() {
    return Model.filterPosts(categoryPosts(), { ...creatorFilters, preserveOrder: true });
  }
  function creatorItems(post) {
    return (post.media || []).filter(media => creatorFilters.type === 'all' || media.type === creatorFilters.type);
  }
  async function scanCreatorTimeline() {
    if (creatorScanning || snapshot.kind !== 'profile') return;
    const token = ++creatorScanToken;
    const url = location.href;
    creatorScanning = true;
    let stable = 0;
    let previousCount = -1;
    try {
      while (token === creatorScanToken && location.href === url && categoryPosts().length < 1000) {
        scanDomCreatorPosts();
        const count = categoryPosts().length;
        stable = count === previousCount ? stable + 1 : 0;
        previousCount = count;
        creatorVisibleLimit = Math.min(1000, Math.max(creatorVisibleLimit, count));
        scheduleCreatorResolve();
        renderCreator();
        if (stable >= 5 || (creatorFilters.limit > 0 && filteredCreatorPosts().length >= Number(creatorFilters.limit))) break;
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
        await new Promise(resolve => setTimeout(resolve, 1800));
      }
    } finally {
      if (token === creatorScanToken) { creatorScanning = false; renderCreator(); }
    }
  }
  const creatorAutoAttempts = new Map();
  function unresolvedAutoPosts() {
    const key = creatorKey;
    return visibleCreatorPosts()
      .map((post) => creatorPosts.get(post.shortcode || post.id) || post)
      .filter((post) => {
        if (!post?.shortcode || creatorReady(post) || creatorAutoAttempts.has(key + ':' + post.shortcode)) return false;
        // A reel tile already has its cover. Fetching every video here fights the page preview and flickers the list.
        if (profileTab() === 'reels' && post.media?.some((item) => item.imageCandidates?.length || Model.allowedMediaUrl(item.posterUrl || '')) && !post.media?.some((item) => item.videoCandidates?.length)) return false;
        return true;
      });
  }
  function scheduleCreatorResolve() {
    clearTimeout(creatorAutoTimer);
    creatorAutoTimer = setTimeout(() => {
      if (snapshot.kind !== 'profile' || creatorPreparing) return;
      if (!unresolvedAutoPosts().length) return;
      refreshCreatorPosts(false).catch((error) => setStatus(error.message, 'error'));
    }, 700);
  }
  const creatorCategories = new Map();
  function profileTab() {
    let sk = '';
    try { sk = new URL(location.href).searchParams.get('sk') || ''; } catch (_) {}
    const path = location.pathname.replace(/\/+$/, '');
    if (/\/reels?$/i.test(path) || /^reels/i.test(sk)) return 'reels';
    if (/\/photos(?:_by|_albums)?$/i.test(path) || /^photos/i.test(sk)) return 'photos';
    if (/\/videos\/?$/i.test(path) || /^videos/i.test(sk)) return 'videos';
    if (/\/media\/?$/i.test(path)) return 'media';
    if (/\/likes\/?$/i.test(path)) return 'likes';
    return 'posts';
  }
  const creatorCategory = () => creatorKey + ':' + profileTab();
  function postMatchesProfileTab(post) {
    const tab = profileTab();
    const url = String(post?.pageUrl || '');
    if (tab === 'reels') return /\/reels?\//i.test(url);
    if (tab === 'photos') return /(?:\/photo(?:\.php)?|[?&]fbid=|\/photos\/)/i.test(url) && !/\/reels?\//i.test(url);
    if (tab === 'videos') return /\/videos\/|\/watch|fb\.watch/i.test(url);
    return true;
  }
  function creatorCoverClass(post) {
    const tab = profileTab();
    if (tab === 'photos') return ' is-photo';
    if (tab === 'reels') return ' is-reel';
    const type = pageType(post);
    if (type === 'video' || type === 'gif' || /\/reels?\//i.test(String(post.pageUrl || ''))) return ' is-reel';
    if (type === 'image' || type === 'carousel') return ' is-photo';
    return '';
  }
  function postHasMedia(post) {
    // Keep only posts that either already have media URLs, or are videos awaiting resolve.
    return Boolean(post?.media?.some((media) =>
      media && (
        media.imageCandidates?.length
        || media.videoCandidates?.length
        || Model.allowedMediaUrl(media.posterUrl || '')
        || media.type === 'video'
        || media.type === 'gif'
      )
    ));
  }

  function postHasDownloadableMedia(post) {
    // Same bar as the feed download button: only keep posts that can yield a file.
    return Boolean(post?.media?.some((media) =>
      Boolean(media?.imageCandidates?.length || media?.videoCandidates?.length || Model.allowedMediaUrl(media?.posterUrl || ''))
    ));
  }

  function categoryPosts() {
    const ids = creatorCategories.get(creatorCategory()) || new Set();
    return [...ids].map(id => creatorPosts.get(id)).filter((post) => post && postHasMedia(post));
  }

  function registerCreatorCategoryIds(posts, category = creatorCategory()) {
    if (!creatorCategories.has(category)) creatorCategories.set(category, new Set());
    const ids = creatorCategories.get(category);
    const previousOrder = [...ids];
    const observed = [];
    (Array.isArray(posts) ? posts : []).forEach((post) => {
      const id = post?.shortcode || post?.id;
      if (!id || !postHasMedia(post)) return;
      ids.add(id);
      observed.push(id);
    });
    if (observed.length) {
      creatorCategories.set(category, new Set(
        mergePageOrder(previousOrder, observed).filter((id) => {
          const post = creatorPosts.get(id);
          return postHasMedia(post) || observed.includes(id);
        })
      ));
    }
    return ids;
  }

  function pruneTextOnlyCreatorPosts(category = creatorCategory()) {
    const ids = creatorCategories.get(category);
    if (!ids) return;
    for (const id of [...ids]) {
      const post = creatorPosts.get(id);
      if (!post) { ids.delete(id); continue; }
      // Drop pure text and permanently empty stubs (no poster / candidates after resolve).
      if (!post.media?.length) {
        ids.delete(id);
        continue;
      }
      if (post.resolvedAt && !postHasDownloadableMedia(post)) ids.delete(id);
    }
  }

  function profilePostsFromSnapshot(payload) {
    return (payload?.posts || []).filter((post) =>
      post?.author?.username?.toLowerCase() === String(creatorKey).toLowerCase()
      && postHasMedia(post));
  }

  function refreshProfileCreatorData(payload = snapshot) {
    if (snapshot.kind !== 'profile') return;
    scanDomCreatorPosts();
    const incoming = profilePostsFromSnapshot(payload).filter(postMatchesProfileTab);
    registerCreatorCategoryIds(incoming);
    mergeCreatorPosts(incoming);
    pruneTextOnlyCreatorPosts();
    incoming.forEach((post) => { if (creatorReady(post)) cacheResolved(post); });
    scheduleCreatorResolve();
  }

  let profileScanTimers = [];
  function scheduleProfileDomScan() {
    profileScanTimers.forEach((timer) => clearTimeout(timer));
    profileScanTimers = [];
    if (snapshot.kind !== 'profile') return;
    [120, 400, 1000].forEach((delay) => {
      profileScanTimers.push(window.setTimeout(() => {
        if (snapshot.kind !== 'profile') return;
        scanDomCreatorPosts();
        registerCreatorCategoryIds(categoryPosts());
        if (shell.panel?.isOpen?.()) renderCreator();
      }, delay));
    });
  }

  function mergePageOrder(previous, observed) {
    if (!observed.length) return previous;
    const seen = new Set(observed);
    const anchor = previous.findIndex(id => seen.has(id));
    const before = anchor < 0 ? previous : previous.slice(0, anchor);
    const after = anchor < 0 ? [] : previous.slice(anchor);
    return [...before.filter(id => !seen.has(id)), ...observed, ...after.filter(id => !seen.has(id))];
  }
  const RESOURCE_CACHE_KEY = 'facebook-dl-resources-v3';
  const RESOURCE_TTL = 6 * 60 * 60 * 1000;
  const resourceCache = new Map();
  let viewedPost = null;
  let viewedPostToken = 0;
  let viewedPostLoading = false;
  let viewedPostArticle = null;
  let detailResolveActive = 0;
  const detailResolveWaiters = [];
  async function resolveCreatorDetail(post) {
    if (detailResolveActive >= 2) await new Promise((resolve) => detailResolveWaiters.push(resolve));
    else detailResolveActive += 1;
    try { return await send('FACEBOOK_DL_RESOLVE_POST_TAB', { shortcode: post.shortcode, username: post.author?.username, pageUrl: post.pageUrl, kind: post.kind }); }
    finally {
      const next = detailResolveWaiters.shift();
      if (next) next();
      else detailResolveActive -= 1;
    }
  }
  function cacheResolved(post, target = creatorPosts) {
    if (!post?.shortcode || !creatorReady(post)) return;
    const previous = resourceCache.get(post.shortcode);
    if (previous && Date.now() - previous.resolvedAt < RESOURCE_TTL &&
        JSON.stringify(previous.media) === JSON.stringify(post.media) && previous.title === post.title && JSON.stringify(previous.authors || []) === JSON.stringify(post.authors || [])) {
      mergeCreatorPosts([previous], target);
      return;
    }
    const entry = { ...post, cacheVersion: 3, resolvedAt: Date.now() };
    resourceCache.delete(post.shortcode);
    resourceCache.set(post.shortcode, entry);
    while (resourceCache.size > 300) resourceCache.delete(resourceCache.keys().next().value);
    mergeCreatorPosts([entry], target);
    send('FACEBOOK_DL_CACHE_WRITE', { post: entry }).catch(() => {});
  }
  const resourceCacheReady = DownloaderKit.runtime.storageGet([RESOURCE_CACHE_KEY], EXT).then((data) => {
    (Array.isArray(data[RESOURCE_CACHE_KEY]) ? data[RESOURCE_CACHE_KEY] : []).slice(-100).forEach((post) => {
      if (post?.shortcode && Date.now() - post.resolvedAt < RESOURCE_TTL) resourceCache.set(post.shortcode, post);
    });
  }).catch(() => {});
  async function readResourceCache(codes) {
    let timer;
    try {
      return await Promise.race([
        send('FACEBOOK_DL_CACHE_READ', { codes }).catch(() => null),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), 2000); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async function loadResourceCache(posts) {
    const codes = posts.map((post) => post.shortcode).filter(Boolean);
    const result = await readResourceCache(codes);
    for (const post of result?.posts || []) {
      resourceCache.set(post.shortcode, post);
      while (resourceCache.size > 300) resourceCache.delete(resourceCache.keys().next().value);
    }
    mergeCreatorPosts(posts);
  }
  function mergeFeedAuthors(post, article) {
    const media = feedMediaBox(article);
    if (!media) return post;
    const authors = [];
    for (const author of [...(post.authors || []), ...(post.author?.username ? [post.author] : [])]) rememberAuthor(authors, author);
    for (const link of article.querySelectorAll('a[href]')) {
      const name = Model.usernameFromUrl(link.href);
      const rect = link.getBoundingClientRect();
      if (!name || rect.top >= media.top) continue;
      const displayName = linkVisibleName(link);
      if (!displayName) continue;
      rememberAuthor(authors, { username: name, displayName, profileUrl: link.href });
    }
    return { ...post, authors };
  }
  async function openFeedPost(article, url) {
    const token = ++viewedPostToken;
    await resourceCacheReady;
    const shortcode = Model.shortcodeOf(url);
    await loadResourceCache([{ shortcode }]);
    if (token !== viewedPostToken) return;
    const video = article.querySelector('video');
    const image = [...article.querySelectorAll('img')].sort((a, b) => b.clientHeight - a.clientHeight)[0];
    const authorAnchor = [...article.querySelectorAll('a[href]')].find((link) => Model.usernameFromUrl(link.href) && linkVisibleName(link));
    const username = authorAnchor ? Model.usernameFromUrl(authorAnchor.href) : '';
    const caption = image?.alt || article.querySelector('h1')?.textContent || [...article.querySelectorAll('span')].map((item) => item.textContent.trim()).find((value) => value.length > 35 && value.length < 1000) || '';
    const videoUrl = Model.allowedMediaUrl(video?.currentSrc || video?.src || '');
    const posterUrl = Model.allowedMediaUrl(video?.poster || '') || Model.allowedMediaUrl(imageFromNode(image));
    viewedPost = resourceCache.get(shortcode) || {
      shortcode, id: shortcode, pageUrl: url, title: caption || t('facebookPostFallback', { id: shortcode }),
      author: { username }, kind: video ? 'video' : 'image',
      media: [{ id: shortcode + '-1', index: 1, type: video ? 'video' : 'image',
        posterUrl, imageCandidates: [], videoCandidates: videoUrl ? [{ url: videoUrl }] : [] }]
    };
    viewedPost = mergeFeedAuthors(viewedPost, article);
    if (creatorReady(viewedPost)) cacheResolved(viewedPost);
    viewedPostArticle = article;
    viewedPostLoading = !creatorReady(viewedPost);
    activeMode = 'current';
    selectedMedia = new Set();
    mediaSelectionPost = '';
    shell.open?.();
    renderView();
    scheduleFeedPosition();
    if (viewedPostLoading) {
      try {
        const post = viewedPost;
        const epoch = requestResolve([{ shortcode, pageUrl: url, kind: post.kind }]);
        await waitForResolve(epoch, 1);
        if (token !== viewedPostToken) return;
        const cached = resourceCache.get(shortcode);
        const result = creatorReady(cached || {}) ? { post: cached } : await resolveCreatorDetail(post).catch(() => null);
        if (result?.post) {
          const resolved = mergeFeedAuthors(result.post, article);
          cacheResolved(resolved);
          if (token === viewedPostToken) viewedPost = resolved;
        }
      } finally {
        if (token === viewedPostToken) { viewedPostLoading = false; renderView(); }
      }
    }
  }

  let creatorVisibleLimit = 60;
  let settingsBody = null;
  let route = location.href;
  let resolveEpoch = 0;
  const detailResolveAttempted = new Set();
  const isDetailRoute = () => ['post', 'profile'].includes(Model.routeFromUrl(location.href).kind);

  function syncFloatingEntry() {
    const toggle = document.getElementById('facebook-dl-toggle');
    if (toggle) {
      toggle.style.display = prefs.showFloatingButton !== false && isDetailRoute() ? '' : 'none';
      const label = t(Model.routeFromUrl(location.href).kind === 'profile' ? 'batchEntry' : 'appTitle');
      toggle.title = label;
      toggle.setAttribute('aria-label', label);
    }
    if (!isDetailRoute() && !viewedPost) shell.hide?.();
  }

  function openProfileBatch() {
    if (Model.routeFromUrl(location.href).kind !== 'profile') return false;
    ++viewedPostToken;
    viewedPost = null;
    viewedPostArticle = null;
    viewedPostLoading = false;
    activeMode = 'creator';
    shell.showHome?.();
    shell.open?.();
    scanDomCreatorPosts();
    renderView();
    return true;
  }

  function feedMediaBox(article) {
    const host = article.getBoundingClientRect();
    const left = host.width > 0 ? host.left : 0;
    const right = host.width > 0 ? host.right : innerWidth;
    const boxes = [...article.querySelectorAll('video, img')].map((media) => media.getBoundingClientRect())
      .filter((box) => box.width > 100 && box.height > 100);
    return boxes.sort((a, b) => {
      const visibleWidth = (box) => Math.max(0, Math.min(box.right, right, innerWidth) - Math.max(box.left, left, 0));
      return visibleWidth(b) * b.height - visibleWidth(a) * a.height;
    })[0];
  }
  function feedHasMedia(article) {
    return [...article.querySelectorAll('img, video')].some((media) => {
      if (media.closest('#facebook-dl-root, .x-dl-post-entry')) return false;
      if (media.tagName === 'VIDEO') return true;
      const width = media.naturalWidth || media.width || media.clientWidth || 0;
      const height = media.naturalHeight || media.height || media.clientHeight || 0;
      if (width && height && width < 120 && height < 120) return false;
      const src = media.currentSrc || media.src || '';
      return !Model.looksLikeAvatar(src) && !Model.STATIC_HINT.test(src);
    });
  }
  // Keep list discovery aligned with the feed download button: media only.
  function profileArticleCollectible(article) {
    return feedHasMedia(article);
  }
  function articlePermalink(article) {
    const selector = 'a[href*="/posts/"], a[href*="/videos/"], a[href*="/reel"], a[href*="/permalink"], a[href*="story_fbid"], a[href*="fbid="], a[href*="/photo"], a[href*="/watch/"], a[href*="fb.watch"], a[href*="/share/"]';
    for (const link of article.querySelectorAll(selector)) {
      if (link.closest('.x-dl-post-entry')) continue;
      const href = link.href || '';
      const route = Model.routeFromUrl(href);
      if (route.kind === 'post' && route.shortcode) return href;
    }
    return '';
  }
  function isReelsShelf(article) {
    if (/^reels\b/i.test((article.innerText || '').trim().slice(0, 40))) return true;
    const heading = [...article.querySelectorAll('h1, h2, h3, h4, [role="heading"]')].find((el) => el.closest('[role="article"]') === article && /^reels$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim()));
    if (heading) return true;
    const codes = new Set();
    for (const link of article.querySelectorAll('a[href*="/reel"]')) {
      const code = Model.shortcodeOf(link.href || '');
      if (!code) continue;
      codes.add(code);
      if (codes.size > 1) return true;
    }
    return false;
  }
  function headerActionAnchor(article) {
    const host = article.getBoundingClientRect();
    if (!host.width) return null;
    const buttons = [...article.querySelectorAll('[aria-label], [aria-haspopup="menu"], [role="button"]')].filter((el) => {
      if (el.closest('.x-dl-post-entry, #facebook-dl-root')) return false;
      const box = el.getBoundingClientRect();
      if (box.width < 20 || box.width > 44 || box.height < 20 || box.height > 44) return false;
      if (box.top - host.top > 78 || box.bottom < host.top) return false;
      if (host.right - box.right > 180) return false;
      return true;
    });
    if (!buttons.length) return null;
    buttons.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    const anchor = buttons[0];
    let row = anchor.parentElement;
    const neighbor = buttons[1];
    if (neighbor) {
      const seen = new Set();
      let node = anchor;
      while (node && node !== article) {
        seen.add(node);
        node = node.parentElement;
      }
      node = neighbor;
      while (node && node !== article && !seen.has(node)) node = node.parentElement;
      if (node && node !== article) row = node;
    }
    if (!row || row === article || row.closest('#facebook-dl-root')) return null;
    let slot = anchor;
    while (slot.parentElement && slot.parentElement !== row) slot = slot.parentElement;
    return { slot };
  }
  function positionFeedEntry(article, entry) {
    const placed = headerActionAnchor(article);
    ['position', 'top', 'left', 'right', 'bottom', 'z-index', 'height'].forEach((prop) => entry.style.removeProperty(prop));
    if (Model.routeFromUrl(location.href).kind === 'feed') {
      entry.classList.remove('is-inline', 'is-header');
      entry.classList.add('is-anchored', 'is-gutter');
      if (entry.parentElement !== article) article.appendChild(entry);
      if (!article.getBoundingClientRect().width) {
        entry.style.visibility = 'hidden';
        return;
      }
      entry.style.visibility = 'visible';
      entry.style.position = 'absolute';
      entry.style.zIndex = '4';
      entry.style.top = '12px';
      entry.style.bottom = 'auto';
      entry.style.right = 'auto';
      entry.style.left = 'calc(100% + 10px)';
      return;
    }
    if (!placed?.slot || !article.getBoundingClientRect().width) {
      entry.classList.remove('is-inline', 'is-header');
      entry.classList.add('is-anchored');
      if (!article.getBoundingClientRect().width) { entry.style.visibility = 'hidden'; return; }
      entry.style.visibility = 'visible';
      entry.style.position = 'absolute';
      entry.style.zIndex = '3';
      entry.style.top = '8px';
      entry.style.right = '12px';
      entry.style.left = 'auto';
      if (entry.parentElement !== article) article.appendChild(entry);
      return;
    }
    entry.classList.add('is-inline', 'is-header');
    entry.classList.remove('is-anchored');
    entry.style.visibility = 'visible';
    if (entry.previousElementSibling !== placed.slot || entry.parentElement !== placed.slot.parentElement) {
      placed.slot.insertAdjacentElement('afterend', entry);
    }
  }
  function positionFeedPanel() {
    const panel = document.getElementById('facebook-dl-menu');
    if (!panel) return;
    const entry = viewedPostArticle?.querySelector('.x-dl-post-entry');
    if (!viewedPost || !entry?.isConnected) {
      panel.classList.remove('is-following');
      ['left', 'top', 'right', 'bottom', 'max-height', 'height', 'min-height', 'position'].forEach((prop) => panel.style.removeProperty(prop));
      return;
    }
    const box = entry.getBoundingClientRect();
    if (box.width < 8) return;
    if (box.bottom < 8 || box.top > innerHeight - 8) {
      shell.panel?.hide?.();
      return;
    }
    const width = panel.getBoundingClientRect().width || 408;
    const gap = 10;
    let left = box.right + gap;
    if (left + width > innerWidth - 12) left = Math.max(8, box.left - width - gap);
    if (left < 8) left = 8;
    const top = box.top;
    panel.classList.add('is-following');
    panel.style.position = 'fixed';
    panel.style.left = left + 'px';
    panel.style.right = 'auto';
    panel.style.top = top + 'px';
    panel.style.bottom = 'auto';
  }
  let feedPositionFrame = 0;
  let feedFollowWatch = 0;
  function syncAnchoredPanel() {
    document.querySelectorAll('[role="article"].x-dl-feed-host > .x-dl-post-entry').forEach((entry) => {
      const article = entry.parentElement;
      if (article) positionFeedEntry(article, entry);
    });
    if (shell.panel?.isOpen?.()) positionFeedPanel();
  }
  function watchFeedFollow() {
    if (feedFollowWatch || !shell.panel?.isOpen?.() || !viewedPostArticle) return;
    const tick = () => {
      if (!shell.panel?.isOpen?.() || !viewedPostArticle) {
        feedFollowWatch = 0;
        return;
      }
      syncAnchoredPanel();
      feedFollowWatch = requestAnimationFrame(tick);
    };
    feedFollowWatch = requestAnimationFrame(tick);
  }
  function scheduleFeedPosition() {
    if (feedPositionFrame) return;
    feedPositionFrame = requestAnimationFrame(() => {
      feedPositionFrame = 0;
      syncAnchoredPanel();
      watchFeedFollow();
    });
  }
  window.addEventListener('scroll', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('#facebook-dl-root')) return;
    scheduleFeedPosition();
    refreshActiveReel();
  }, { passive: true, capture: true });
  document.addEventListener('playing', (event) => {
    if (event.target?.tagName === 'VIDEO') refreshActiveReel();
  }, true);
  document.addEventListener('load', (event) => {
    const article = event.target?.closest?.('[role="article"].x-dl-feed-host');
    const entry = article?.querySelector('.x-dl-post-entry');
    if (entry) positionFeedEntry(article, entry);
  }, true);
  window.addEventListener('resize', () => {
    document.querySelectorAll('[role="article"] .x-dl-post-entry').forEach((entry) => {
      const article = entry.closest('[role="article"]');
      if (article) positionFeedEntry(article, entry);
    });
    scheduleFeedPosition();
  }, { passive: true });
  function readCollaboratorDialog() {
    if (!viewedPost?.author?.username) return;
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((item) => /合作者|合作创作者|collaborators/i.test(item.textContent || '') && !item.closest('#facebook-dl-root'));
    if (!dialog) return;
    const authors = [];
    for (const link of dialog.querySelectorAll('a[href]')) {
      const match = new URL(link.href, location.href).pathname.match(/^\/([a-zA-Z0-9_.]+)\/?$/);
      if (match && !authors.some((item) => item.username === match[1])) authors.push({ username: match[1], displayName: linkVisibleName(link) || match[1] });
    }
    if (!authors.some((item) => item.username.toLowerCase() === viewedPost.author.username.toLowerCase())) return;
    if (authors.length > 1 && JSON.stringify(authors) !== JSON.stringify(viewedPost.authors)) {
      viewedPost = { ...viewedPost, authors };
      cacheResolved(viewedPost);
      if (shell.panel?.isOpen?.()) renderCurrent();
    }
  }
  const AD_LABEL = /^(?:赞助内容|赞助|贊助內容|贊助|Sponsored|Sponsorisé|Sponsorisiert|Gesponsert|Patrocinado|Publicidad|Promoted|広告|스폰서|推广内容|推广)$/i;
  function isSponsoredArticle(article) {
    const top = article.getBoundingClientRect().top;
    for (const el of article.querySelectorAll('span, a, strong, abbr')) {
      if (el.closest('.x-dl-post-entry, #facebook-dl-root')) continue;
      if (el.children.length > 1) continue;
      const value = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!value || value.length > 20 || !AD_LABEL.test(value)) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || rect.height > 32) continue;
      if (rect.top - top > 200) continue;
      return true;
    }
    return false;
  }
  function updateAdVisibility() {
    const hide = prefs.hideAds !== false;
    document.querySelectorAll('.x-dl-hidden-ad').forEach((element) => element.classList.remove('x-dl-hidden-ad'));
    if (hide) {
      document.querySelectorAll('[role="article"]').forEach((article) => {
        if (article.closest('#facebook-dl-root') || !isSponsoredArticle(article)) return;
        article.classList.add('x-dl-hidden-ad');
        article.classList.remove('x-dl-feed-host');
        article.querySelector('.x-dl-post-entry')?.remove();
        const pagelet = article.closest('[data-pagelet]');
        if (pagelet && !pagelet.closest('#facebook-dl-root') && pagelet.querySelectorAll('[role="article"]').length === 1) {
          pagelet.classList.add('x-dl-hidden-ad');
        }
      });
    }
    window.postMessage({ source: CONTENT_SOURCE, type: 'AD_SETTINGS', hideAds: hide }, location.origin);
  }
  function feedEntryEnabled() {
    return ['feed', 'profile'].includes(Model.routeFromUrl(location.href).kind);
  }
  function clearFeedEntries() {
    document.querySelectorAll('.x-dl-post-entry').forEach((entry) => {
      entry.closest('[role="article"]')?.classList.remove('x-dl-feed-host');
      entry.remove();
    });
  }
  function addFeedEntries() {
    readCollaboratorDialog();
    updateAdVisibility();
    if (!feedEntryEnabled()) {
      clearFeedEntries();
      return;
    }
    document.querySelectorAll('[role="article"]').forEach((article) => {
      if (article.closest('#facebook-dl-root') || article.classList.contains('x-dl-hidden-ad') || isReelsShelf(article)) {
        if (!article.closest('#facebook-dl-root')) {
          article.querySelector('.x-dl-post-entry')?.remove();
          article.classList.remove('x-dl-feed-host');
        }
        return;
      }
      const existing = article.querySelector('.x-dl-post-entry');
      if (!feedHasMedia(article)) {
        existing?.remove();
        article.classList.remove('x-dl-feed-host');
        return;
      }
      if (existing) {
        const currentHref = articlePermalink(article);
        if (currentHref) existing.href = currentHref;
        const label = t('feedPostEntry');
        existing.setAttribute('aria-label', label);
        let labelEl = existing.querySelector('.x-dl-post-entry-label');
        if (!labelEl) {
          labelEl = document.createElement('span');
          labelEl.className = 'x-dl-post-entry-label';
          existing.appendChild(labelEl);
        }
        labelEl.textContent = label;
        positionFeedEntry(article, existing);
        return;
      }
      const href = articlePermalink(article);
      if (!href || !Model.shortcodeOf(href)) return;
      const entry = document.createElement('a');
      entry.className = 'x-dl-post-entry';
      entry.href = href;
      const label = t('feedPostEntry');
      entry.setAttribute('aria-label', label);
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('width', '14');
      icon.setAttribute('height', '14');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '1.8');
      icon.setAttribute('stroke-linecap', 'round');
      icon.setAttribute('stroke-linejoin', 'round');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('focusable', 'false');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5');
      icon.appendChild(path);
      const labelEl = document.createElement('span');
      labelEl.className = 'x-dl-post-entry-label';
      labelEl.textContent = label;
      entry.append(icon, labelEl);
      entry.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openFeedPost(article, entry.href).catch((error) => setStatus(error.message, 'error')); });
      article.classList.add('x-dl-feed-host');
      positionFeedEntry(article, entry);
    });
    scheduleFeedPosition();
  }

  window.addEventListener('resize', () => { clearTimeout(feedEntryTimer); feedEntryTimer = setTimeout(addFeedEntries, 150); });
  let feedEntryTimer = 0;
  const feedEntryObserver = new MutationObserver((mutations) => {
    if (!feedEntryEnabled()) return;
    if (!mutations.some((mutation) => [...mutation.addedNodes].some((item) => item.nodeType === 1 &&
      !item.closest?.('#facebook-dl-root, .x-dl-post-entry') &&
      (item.matches?.('[role="article"], img, video, [role="dialog"], a[href]') || item.querySelector?.('[role="article"], img, video, [role="dialog"], a[href]'))))) return;
    clearTimeout(feedEntryTimer);
    feedEntryTimer = setTimeout(addFeedEntries, 250);
  });
  feedEntryObserver.observe(document.documentElement, { childList: true, subtree: true });

  function t(key, values) {
    return DownloaderKit.i18n?.t?.(key, values) || key;
  }

  const shell = DownloaderKit.shell.mount({
    title: 'Facebook Downloader',
    idPrefix: 'facebook-dl',
    theme: 'facebook',
    initialTheme: 'default',
    themeKey: 'facebook-dl-theme-v1',
    settingsKey: 'facebook-dl-filename-v1',
    showDebug: false,
    configUrl: 'http://124.222.62.190:8081/api/config/facebook',
    messageType: 'FACEBOOK_DL_FETCH_JSON',
    cacheKey: 'facebook-dl-remote-v1',
    ratingKey: 'facebook-dl-rating-v1',
    footer: {
      variant: 'actions',
      showHelpLinks: false,
      showSettings: true,
      showNotice: false,
      showDiagnostics: false,
      faqUrl: 'https://snowflake-hangdudu.github.io/Facebook-Downloader/faq.html',
      privacyUrl: 'https://snowflake-hangdudu.github.io/Facebook-Downloader/',
      email: 'hangdudu0@agent.qq.com',
      subject: 'Facebook Downloader feedback'
    },
    onFillSettings: fillSettingsSheet,
    onFeedback: copyFeedbackEmail,
    defaults: {
      notice: {
        enabled: true,
        title: '公告',
        pinned: ['仅保存你在 Facebook 页面中可正常访问、且有权保存的公开内容。'],
        recent: [
          '1.0.1：信息流下载按钮随帖子滚动，面板跟着按钮移动；创作者与 Reel 作者会随当前内容更新。',
          '1.0.0：支持识别当前帖子、Reel、多图选择、信息流入口和个人主页扫描。',
          '可保存视频与图片；下载任务支持暂停、继续、取消和重试。',
          '默认隐藏首页赞助内容，可在设置中关闭。'
        ],
        knownIssues: [
          '地区、登录或私密限制导致的内容，本扩展无法绕过。',
          '部分视频地址会过期，扩展会尝试备用地址后再下载。'
        ],
        roadmap: {
          feedback: ['遇到问题请点底部「反馈」，复制邮箱后附上帖子链接和截图。'],
          upcoming: [],
          planned: []
        }
      },
      coop: {
        enabled: true,
        title: '开发合作',
        body: '接浏览器插件定制开发。\n\n有合作意向请联系 QQ：748604487\n邮箱：hangdudu0@agent.qq.com\n请备注「插件开发」，并简单说明需求。'
      },
      // Store URLs stay empty until listing is published; remote config enables rating jump.
      rating: { enabled: false, url: '', edge: '', chrome: '', firefox: '', minSuccess: 3 }
    },
    messages: {
      openPanel: 'FACEBOOK_DL_OPEN_PANEL',
      openSheet: 'FACEBOOK_DL_OPEN_SHEET'
    },
    tasks: {
      list: async () => (await getTasks()).map((task) => ({
        id: task.id,
        title: task.title || t('facebookPost'),
        state: taskStatusLabel(task),
        actions: taskActions(task).map(([action]) => action)
      })),
      cancel: (id) => controlTask(id, 'cancel'),
      pause: (id) => controlTask(id, 'pause'),
      resume: (id) => controlTask(id, 'resume'),
      retry: (id) => controlTask(id, 'retry')
    }
  });

  const ui = document.createElement('div');
  ui.className = 'x-dl';
  ui.innerHTML = `
    <div class="x-dl-mode-tabs hidden" role="tablist" data-i18n-aria="modeLabel">
      <button type="button" data-mode="current" class="active" role="tab" data-i18n="currentContent">Current</button>
      <button type="button" data-mode="creator" role="tab" data-i18n="creator">Creator</button>
    </div>
    <div class="x-dl-current-body"></div>
    <div class="x-dl-creator-body hidden"></div>
    <div class="x-dl-job-panel hidden">
      <div class="x-dl-job-list"></div>
      <div class="x-dl-job-panel-queue hidden">
        <button type="button" class="x-dl-action-btn" data-bulk="pause-all" data-i18n="pauseAll">Pause all</button>
        <button type="button" class="x-dl-action-btn danger" data-bulk="cancel-all" data-i18n="cancelAll">Cancel all</button>
      </div>
      <p class="x-dl-job-more hidden"></p>
    </div>
    <div class="x-status" hidden role="status"></div>
  `;
  shell.home.appendChild(ui);

  const tabsEl = ui.querySelector('.x-dl-mode-tabs');
  const currentBody = ui.querySelector('.x-dl-current-body');
  const creatorBody = ui.querySelector('.x-dl-creator-body');
  const jobPanelEl = ui.querySelector('.x-dl-job-panel');
  const jobListEl = ui.querySelector('.x-dl-job-list');
  const appStatus = ui.querySelector('.x-status');
  let jobWatchTimer = 0;
  let shownJobIds = new Set();
  const completionWatchIds = new Set();
  jobPanelEl?.querySelectorAll('[data-bulk]').forEach((btn) => {
    btn.addEventListener('click', () => {
      bulkTask(btn.dataset.bulk).then(() => refreshJobPanel()).catch((error) => setStatus(error.message, 'error'));
    });
  });
  tabsEl.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      activeMode = button.dataset.mode || 'current';
      syncTabs();
      if (activeMode === 'creator' && snapshot.kind === 'profile') scanDomCreatorPosts();
      renderView();
    });
  });

  document.getElementById('facebook-dl-toggle')?.addEventListener('click', () => {
    if (snapshot.kind === 'profile') {
      refreshProfileCreatorData();
      scheduleProfileDomScan();
      window.postMessage({ source: CONTENT_SOURCE, type: 'GET_SNAPSHOT' }, location.origin);
    }
    renderView();
  });

  function node(parent, tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value != null) element.textContent = String(value);
    if (parent) parent.appendChild(element);
    return element;
  }
  function creatorEmptyIcon(parent) {
    const wrap = node(parent, 'div', 'x-empty-icon');
    wrap.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    [[3, 3], [14, 3], [3, 14], [14, 14]].forEach(([x, y]) => {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', '7');
      rect.setAttribute('height', '7');
      rect.setAttribute('rx', '1.5');
      svg.appendChild(rect);
    });
    wrap.appendChild(svg);
    return wrap;
  }
  function button(parent, label, className, onClick) {
    const result = node(parent, 'button', className || 'x-mini-button', label);
    result.type = 'button';
    if (onClick) result.addEventListener('click', onClick);
    return result;
  }
  function send(type, extra) {
    return DownloaderKit.runtime.sendMessage({ type, ...(extra || {}) }, EXT).then((result) => {
      if (result && result.ok === false) throw new Error(result.error || t('actionFailed'));
      return result || { ok: true };
    });
  }
  function copyFeedbackEmail() {
    const email = 'hangdudu0@agent.qq.com';
    navigator.clipboard?.writeText(email).then(() => setStatus(t('copied'), 'info')).catch(() => setStatus(email, 'info'));
  }
  function setStatus(message, kind) {
    if (!appStatus) return;
    clearTimeout(setStatus.timer);
    appStatus.replaceChildren();
    if (!message && kind !== 'success') {
      appStatus.hidden = true;
      return;
    }
    appStatus.hidden = false;
    appStatus.dataset.kind = kind || 'info';
    if (kind === 'success') {
      appStatus.appendChild(document.createTextNode(t('saved')));
      button(appStatus, t('viewDownloads'), 'x-status-action', () => send('FACEBOOK_DL_OPEN_DOWNLOADS').catch(() => {}));
    } else appStatus.appendChild(document.createTextNode(String(message)));
    setStatus.timer = setTimeout(() => { appStatus.hidden = true; }, 5000);
  }
  function getTasks() {
    return send('FACEBOOK_DL_QUEUE_LIST').then((result) => Array.isArray(result.tasks) ? result.tasks : []);
  }
  function getHistory() {
    return send('FACEBOOK_DL_HISTORY_LIST').then((result) => Array.isArray(result.history) ? result.history : []);
  }
  function controlTask(id, action) {
    return send('FACEBOOK_DL_QUEUE_CONTROL', { id, action });
  }
  function bulkTask(action) {
    return send('FACEBOOK_DL_QUEUE_BULK', { action });
  }
  function taskStatusLabel(task) {
    return ({
      resolving: t('statusResolving'),
      waiting: t('statusWaiting'),
      downloading: t('statusDownloading'),
      paused: t('statusPaused'),
      completed: t('statusCompleted'),
      failed: t('statusFailed'),
      cancelled: t('statusCancelled')
    })[task?.status] || t('statusUnknown');
  }
  function taskActions(task) {
    if (task.status === 'downloading' || task.status === 'resolving') return [['pause', t('pause')], ['cancel', t('cancel')]];
    if (task.status === 'paused') return [['resume', t('resume')], ['cancel', t('cancel')]];
    if (task.status === 'waiting') return [['cancel', t('cancel')]];
    if (task.status === 'failed' || task.status === 'cancelled') return [['retry', t('retryTask')]];
    return [];
  }
  function currentQueue() {
    return activeMode === 'creator' ? 'creator' : 'current';
  }
  function taskQueue(task) {
    return task?.queue === 'creator' ? 'creator' : 'current';
  }
  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }
  function jobProgressSnapshot(task) {
    const received = Number(task.bytesReceived) || 0;
    const total = Number(task.totalBytes) || 0;
    const pct = task.status === 'completed'
      ? 100
      : (total > 0 ? Math.min(100, Math.round(received * 100 / total)) : Math.max(0, Math.min(100, Number(task.progress) || 0)));
    const known = task.status === 'completed' || total > 0 || pct > 0;
    const subText = total > 0
      ? formatBytes(received) + ' / ' + formatBytes(total)
      : (received ? formatBytes(received) : '');
    const quality = task.quality || (task.mediaType === 'video' ? t('pageTypeVideo') : t('pageTypeImage'));
    return { received, total, pct, known, subText, quality };
  }
  function bindJobActions(row, task) {
    const actions = row.querySelector('.x-dl-progress-actions');
    if (!actions) return;
    if (actions.dataset.status === task.status) return;
    actions.dataset.status = task.status;
    actions.replaceChildren();
    actions.classList.toggle('hidden', task.status === 'completed');
    if (task.status === 'completed') return;
    taskActions(task).forEach(([action, label]) => {
      if (!['pause', 'resume', 'cancel'].includes(action)) return;
      const actionBtn = button(actions, label, 'x-dl-action-btn', () => {
        controlTask(task.id, action).then(() => refreshJobPanel()).catch((error) => setStatus(error.message, 'error'));
      });
      if (action === 'cancel') actionBtn.classList.add('danger');
    });
  }
  function createJobRow(task) {
    const snap = jobProgressSnapshot(task);
    const row = document.createElement('div');
    row.className = 'x-dl-progress';
    row.dataset.jobId = task.id;
    const meta = node(row, 'div', 'x-dl-progress-meta');
    const title = node(meta, 'span', 'x-dl-progress-title', task.title || task.filename || t('downloadTask'));
    title.title = task.filename || task.title || '';
    node(meta, 'span', 'x-dl-progress-q', snap.quality);
    const head = node(row, 'div', 'x-dl-progress-head');
    node(head, 'span', 'x-dl-job-phase', taskStatusLabel(task));
    const pctEl = node(head, 'span', 'x-dl-job-pct', snap.known ? snap.pct + '%' : '');
    pctEl.classList.toggle('hidden', !snap.known);
    const sub = node(row, 'div', 'x-dl-progress-sub' + (snap.subText ? '' : ' hidden'), snap.subText);
    if (task.filename) sub.title = task.filename;
    const track = node(row, 'div', 'x-dl-progress-track');
    const bar = node(track, 'div', 'x-dl-progress-bar' + (snap.known ? '' : ' indeterminate') + (task.status === 'paused' ? ' paused' : ''));
    bar.style.width = (snap.known ? snap.pct : 35) + '%';
    node(row, 'div', 'x-dl-progress-actions');
    bindJobActions(row, task);
    return row;
  }
  function updateJobRow(row, task) {
    const snap = jobProgressSnapshot(task);
    const title = row.querySelector('.x-dl-progress-title');
    if (title) {
      const next = task.title || task.filename || t('downloadTask');
      if (title.textContent !== next) title.textContent = next;
      title.title = task.filename || task.title || '';
    }
    const qualityEl = row.querySelector('.x-dl-progress-q');
    if (qualityEl && qualityEl.textContent !== snap.quality) qualityEl.textContent = snap.quality;
    const phaseEl = row.querySelector('.x-dl-job-phase');
    const phase = taskStatusLabel(task);
    if (phaseEl && phaseEl.textContent !== phase) phaseEl.textContent = phase;
    const pctEl = row.querySelector('.x-dl-job-pct');
    if (pctEl) {
      const next = snap.known ? snap.pct + '%' : '';
      if (pctEl.textContent !== next) pctEl.textContent = next;
      pctEl.classList.toggle('hidden', !snap.known);
    }
    const sub = row.querySelector('.x-dl-progress-sub');
    if (sub) {
      if (sub.textContent !== snap.subText) sub.textContent = snap.subText;
      sub.classList.toggle('hidden', !snap.subText);
      if (task.filename) sub.title = task.filename;
    }
    const bar = row.querySelector('.x-dl-progress-bar');
    if (bar) {
      bar.classList.toggle('indeterminate', !snap.known);
      bar.classList.toggle('paused', task.status === 'paused');
      const width = (snap.known ? snap.pct : 35) + '%';
      if (bar.style.width !== width) bar.style.width = width;
    }
    bindJobActions(row, task);
  }
  async function refreshJobPanel() {
    if (!jobPanelEl || !jobListEl) return;
    const listed = await getTasks().catch(() => []);
    const scope = currentQueue();
    const active = (Array.isArray(listed) ? listed : []).filter((task) => ['resolving', 'waiting', 'downloading', 'paused'].includes(task.status) && taskQueue(task) === scope);
    const justFinished = (Array.isArray(listed) ? listed : []).filter((task) =>
      task.status === 'completed' && (completionWatchIds.has(task.id) || (shownJobIds.has(task.id) && taskQueue(task) === scope)));
    if (justFinished.length) {
      setStatus(t('saved'), 'success');
      shell.noteSuccess?.();
    }
    (Array.isArray(listed) ? listed : []).filter((task) => ['completed', 'failed', 'cancelled'].includes(task.status))
      .forEach((task) => completionWatchIds.delete(task.id));
    const current = active.find((task) => task.status === 'downloading')
      || active.find((task) => task.status === 'resolving')
      || active.find((task) => task.status === 'waiting')
      || active[0];
    const tasks = current ? [current] : [];
    const shouldShow = tasks.length > 0;
    jobPanelEl.classList.toggle('hidden', !shouldShow);
    ui.classList.toggle('is-queue', shouldShow);
    if (!shouldShow) {
      jobListEl.replaceChildren();
      jobPanelEl.querySelector('.x-dl-job-panel-queue')?.classList.add('hidden');
      jobPanelEl.querySelector('.x-dl-job-more')?.classList.add('hidden');
      shownJobIds = new Set();
      clearTimeout(jobWatchTimer);
      return;
    }
    const more = jobPanelEl.querySelector('.x-dl-job-more');
    if (more) {
      const extra = Math.max(0, active.length - tasks.length);
      more.classList.toggle('hidden', extra < 1);
      more.textContent = extra ? t('queueMore', { count: active.length }) : '';
    }
    const queueActions = jobPanelEl.querySelector('.x-dl-job-panel-queue');
    queueActions?.classList.toggle('hidden', active.length < 2);
    const pauseAllBtn = queueActions?.querySelector('[data-bulk="pause-all"], [data-bulk="resume-all"]');
    if (pauseAllBtn) {
      const runnable = active.some((task) => task.status === 'downloading' || task.status === 'waiting' || task.status === 'resolving');
      pauseAllBtn.dataset.bulk = runnable ? 'pause-all' : 'resume-all';
      pauseAllBtn.textContent = runnable ? t('pauseAll') : t('resumeAll');
    }
    shownJobIds = new Set(active.map((task) => task.id));
    clearTimeout(jobWatchTimer);
    if (active.length) jobWatchTimer = setTimeout(() => { refreshJobPanel().catch(() => {}); }, 900);
    const keep = new Set(tasks.map((task) => task.id));
    [...jobListEl.children].forEach((row) => {
      if (!keep.has(row.dataset.jobId)) row.remove();
    });
    tasks.forEach((task) => {
      let row = jobListEl.querySelector('[data-job-id="' + CSS.escape(String(task.id)) + '"]');
      if (!row) {
        row = createJobRow(task);
        jobListEl.appendChild(row);
      } else {
        updateJobRow(row, task);
      }
    });
  }
  function coverMediaFrom(media) {
    const candidates = [...(media.imageCandidates || [])];
    if (media.posterUrl && !candidates.some((item) => item.url === media.posterUrl)) {
      candidates.unshift({ url: media.posterUrl, width: media.width || 0, height: media.height || 0, source: 'poster' });
    }
    return { ...media, type: 'image', id: String(media.id || 'media') + '-cover', imageCandidates: candidates, videoCandidates: [] };
  }
  function collapseDuplicateMedia(post) {
    if (!post?.media || post.media.length < 2 || typeof Model.uniqueMedia !== 'function') return post;
    const media = Model.uniqueMedia(post.media).map((item, index) => ({ ...item, index: index + 1 }));
    if (media.length === post.media.length) return post;
    const kind = media.length > 1 ? 'carousel' : (media[0]?.type === 'video' ? 'video' : 'image');
    return { ...post, media, kind, expectedMediaCount: media.length };
  }
  function currentPost() {
    const source = collapseDuplicateMedia(viewedPost || snapshot.post || null);
    const enriched = ensureVisibleTitle(ensureVisibleAuthor(source));
    if (enriched && enriched !== source) {
      if (viewedPost) viewedPost = enriched;
      else if (snapshot.post) snapshot.post = enriched;
    }
    return enriched;
  }
  function postCoverShape(media) {
    let width = Number(media?.width) || 0;
    let height = Number(media?.height) || 0;
    const sized = (media?.imageCandidates || []).find((item) => Number(item?.width) > 20 && Number(item?.height) > 20);
    if (!(width > 20 && height > 20) && sized) {
      width = Number(sized.width);
      height = Number(sized.height);
    }
    if (!(width > 20 && height > 20)) {
      const scope = viewedPostArticle?.isConnected ? viewedPostArticle : null;
      let best = 0;
      for (const el of scope?.querySelectorAll('img, video') || []) {
        if (el.closest('#facebook-dl-root, .x-dl-post-entry')) continue;
        const naturalWidth = el.naturalWidth || el.videoWidth || 0;
        const naturalHeight = el.naturalHeight || el.videoHeight || 0;
        if (naturalWidth < 80 || naturalHeight < 80 || naturalWidth * naturalHeight <= best) continue;
        best = naturalWidth * naturalHeight;
        width = naturalWidth;
        height = naturalHeight;
      }
    }
    if (!(width > 20 && height > 20)) return '';
    const ratio = width / height;
    if (ratio < 0.72) return 'is-portrait';
    if (ratio < 0.98) return 'is-post';
    if (ratio < 1.15) return 'is-square';
    return '';
  }
  function pageType(post) {
    if ((post?.media || []).length > 1 || post?.kind === 'carousel') return 'carousel';
    if (post?.media?.[0]?.type === 'gif' || post?.kind === 'gif') return 'gif';
    if (post?.media?.[0]?.type === 'video' || post?.kind === 'video') return 'video';
    return 'image';
  }
  function pageTypeLabel(post) {
    return ({
      image: t('pageTypeImage'),
      video: t('pageTypeVideo'),
      gif: t('pageTypeGif'),
      carousel: t('pageTypeCarousel')
    })[pageType(post)] || t('unsupportedPage');
  }
  function pickResource(media) {
    if (!media) return null;
    if (media.type === 'video' || media.type === 'gif') return Model.pickBest(media.videoCandidates, 'video');
    const sorted = Model.sortImageCandidates(media.imageCandidates || []);
    if (prefs.imageQuality === 'display') return sorted.find((item) => item.source === 'dom' || item.source === 'srcset') || sorted[0] || null;
    return Model.pickBest(sorted, 'image');
  }
  function mediaExt(media, resource) {
    if (media?.type === 'video' || media?.type === 'gif') return 'mp4';
    const url = String(resource?.url || media?.posterUrl || '');
    const match = url.match(/\.(jpe?g|png|webp|heic)(?:$|\?)/i);
    return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  }
  async function taskFilename(post, media, resource) {
    await shell.settings?.ready;
    const format = mediaExt(media, resource);
    const quality = resource?.width && resource?.height ? (resource.width + 'x' + resource.height) : t('highestAvailable');
    const meta = {
      title: post?.title || t('facebookPostFallback', { id: post?.shortcode || post?.id || '' }),
      author: post?.author?.username || post?.author?.displayName || 'Facebook',
      id: post?.shortcode || post?.id || '',
      index: media?.index || 1,
      quality,
      date: (post?.publishTime || new Date().toISOString()).slice(0, 10)
    };
    const template = shell.settings?.current?.()?.filenameTemplate || prefs.filenameTemplate;
    let name = shell.settings?.filename(meta, format) || (meta.title + '.' + format);
    name = Model.withAutoIndex(name, media?.index || 1, post?.media?.length || 1, template);
    const prefix = Model.folderPrefix(prefs, post);
    return prefix + name;
  }
  function downloadKey(post, media) {
    return Model.downloadKey(post?.id || post?.shortcode, media);
  }
  async function completedKeys() {
    const history = await getHistory().catch(() => []);
    const stored = await DownloaderKit.runtime.storageGet(['facebook-dl-completed-keys-v1'], EXT);
    return new Set([...(stored['facebook-dl-completed-keys-v1'] || []), ...history.filter((item) => item.status === 'completed').map((item) => item.downloadKey || Model.downloadKey(item.postId, item))]);
  }
  async function enqueueMedia(post, items, options) {
    const opts = options || {};
    const tasks = [];
    for (const media of items) {
      const resource = pickResource(media);
      if (!resource?.url) continue;
      const key = downloadKey(post, media);
      tasks.push({
        id: 'x-' + key + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        postId: post.id || post.shortcode,
        shortcode: post.shortcode || '',
        mediaId: media.id,
        index: media.index,
        totalCount: post.media?.length || 1,
        mediaType: media.type,
        type: media.type,
        author: post.author?.username || '',
        creatorId: post.author?.id || '',
        title: post.title,
        publishTime: post.publishTime || '',
        pageUrl: post.pageUrl || location.href,
        url: resource.url,
        backupUrls: resource.backupUrls || [],
        quality: resource.width && resource.height ? (resource.width + 'x' + resource.height) : t('highestAvailable'),
        format: mediaExt(media, resource),
        filename: await taskFilename(post, media, resource),
        coverUrl: media.posterUrl || '',
        width: resource.width || media.width || 0,
        height: resource.height || media.height || 0,
        downloadKey: key,
        queue: opts.queue || 'current',
        recordHistory: prefs.recordHistory,
        forceDuplicate: opts.respectSkipDownloaded ? prefs.skipDownloaded === false : true
      });
    }
    if (!tasks.length) {
      setStatus(t('noResource'), 'warn');
      return { added: 0 };
    }
    const result = await send('FACEBOOK_DL_QUEUE_ADD', { tasks });
    const notes = [];
    if (result.added) notes.push(t('addedTasks', { count: result.added }));
    if (result.duplicateCount) notes.push(t('alreadyQueued'));
    if (result.invalidCount) notes.push(t('invalidDownloadCount', { count: result.invalidCount }));
    setStatus(notes.join(' · ') || t('noNewTasks'), result.added ? 'info' : 'warn');
    const submitted = new Set(tasks.map((task) => task.id));
    (result.tasks || []).filter((task) => submitted.has(task.id)).forEach((task) => completionWatchIds.add(task.id));
    refreshJobPanel().catch(() => {});
    renderView();
    return result;
  }

  function isReelPage() {
    return /^\/reels?\//i.test(location.pathname);
  }
  function decodeRepeated(value) {
    let raw = String(value || '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 3 && /%[0-9A-Fa-f]{2}/.test(raw); i += 1) {
      try {
        const next = decodeURIComponent(raw.replace(/\+/g, ' '));
        if (!next || next === raw) break;
        raw = next;
      } catch (_) { break; }
    }
    return raw.replace(/[\u200B-\u200D\uFEFF\u2060]/g, '').replace(/%[0-9A-Fa-f]{2}/g, '').replace(/\s+/g, ' ').trim();
  }
  function cleanHandle(value) {
    const raw = decodeRepeated(value).replace(/^@/, '');
    if (/^\d{5,}$/.test(raw)) return raw;
    return /^[A-Za-z0-9.]{2,50}$/.test(raw) ? raw : '';
  }
  function cleanPersonName(value) {
    return decodeRepeated(value).replace(/^@/, '');
  }
  function isPresenceLabel(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    if (/在线状态指示|線上狀態指示|在線狀態指示|active status indicator|online status indicator|activity status indicator/i.test(text)) return true;
    return /^(在线|在線|活跃|活躍|active|online|active now)$/i.test(text);
  }
  function personNameFrom(value) {
    let text = cleanPersonName(value)
      .replace(/^[·•.\s]+/, '')
      .replace(/\s*[·•]\s*(关注|追蹤|Following|Follow)$/i, '')
      .replace(/(在线状态指示标|在线状态指示器|線上狀態指示標|線上狀態指示器|在線狀態指示標|在線狀態指示器|Active status indicator|Online status indicator|Activity status indicator)/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    text = text.replace(/^(在线|在線|活跃|活躍|Active now|Active|Online)\s+/i, '')
      .replace(/\s+(在线|在線|活跃|活躍|Active now|Active|Online)$/i, '')
      .replace(/\s*(?:的时间线|的時間線|的动态时报|的動態時報|'s timeline)$/i, '')
      .trim();
    if (!text || /%/.test(text) || isPresenceLabel(text) || /^(关注|追蹤|Following|Follow)$/i.test(text)) return '';
    return text;
  }
  function linkVisibleName(link) {
    const chunks = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) chunks.push(text);
        return;
      }
      if (node.nodeType !== 1 || node === link) {
        for (const child of node.childNodes || []) walk(child);
        return;
      }
      const aria = node.getAttribute?.('aria-label') || '';
      if (aria && isPresenceLabel(aria)) return;
      const own = [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent).join('');
      if (own.trim() && isPresenceLabel(own) && !node.childElementCount) return;
      for (const child of node.childNodes) walk(child);
    };
    walk(link);
    return personNameFrom(chunks.join(' ')) || personNameFrom(link.getAttribute?.('aria-label') || '');
  }
  function authorLabel(author) {
    const display = personNameFrom(author?.displayName || '');
    const handle = cleanHandle(author?.username || '');
    if (display) return display;
    if (handle && !/^\d+$/.test(handle)) return '@' + handle;
    return '';
  }
  function rememberAuthor(authors, author) {
    const username = cleanHandle(author?.username || '') || String(author?.username || '').trim();
    if (!username) return;
    const displayName = personNameFrom(author?.displayName || '');
    const existing = authors.find((item) => String(item.username || '').toLowerCase() === username.toLowerCase());
    if (!existing) {
      authors.push({ ...author, username, displayName });
      return;
    }
    if (displayName && !personNameFrom(existing.displayName)) existing.displayName = displayName;
    if (!existing.avatar && author?.avatar) existing.avatar = author.avatar;
    if (!existing.profileUrl && author?.profileUrl) existing.profileUrl = author.profileUrl;
  }
  function reelOverlayAvatar() {
    const video = activeReelVideo();
    const box = video?.getBoundingClientRect();
    const scope = document.querySelector('[role="main"]') || document.body;
    const region = box && box.width > 80 && box.height > 120 ? box : {
      top: innerHeight * 0.4,
      left: 0,
      width: innerWidth,
      height: innerHeight * 0.6,
      bottom: innerHeight
    };
    let best = '';
    let bestSize = 0;
    const consider = (rect, href) => {
      if (!href || Model.STATIC_HINT.test(href)) return;
      const size = Math.min(rect.width, rect.height);
      if (size < 24 || size > 80 || Math.abs(rect.width - rect.height) > 16) return;
      if (rect.top < region.top + region.height * 0.42 || rect.bottom > region.bottom + 16) return;
      if (rect.left < region.left - 12 || rect.left > region.left + region.width * 0.42) return;
      if (size > bestSize) {
        bestSize = size;
        best = href;
      }
    };
    for (const el of scope.querySelectorAll('img, image')) {
      if (el.closest('#facebook-dl-root, .x-dl-post-entry')) continue;
      let rect = el.getBoundingClientRect();
      if (rect.width < 20 && el.parentElement) {
        const parent = el.parentElement.getBoundingClientRect();
        if (parent.width >= 24 && parent.width <= 84) rect = parent;
      }
      consider(rect, upgradeAvatarUrl(profileImageSource(el)));
    }
    for (const el of scope.querySelectorAll('div, span, a, i')) {
      if (el.closest('#facebook-dl-root, .x-dl-post-entry')) continue;
      const rect = el.getBoundingClientRect();
      const match = (getComputedStyle(el).backgroundImage || '').match(/url\(["']?(https:[^"')]+)/i);
      if (match) consider(rect, upgradeAvatarUrl(match[1]));
    }
    return best;
  }
  function nearbyReelAvatar(link) {
    if (!link) return '';
    const linkBox = link.getBoundingClientRect();
    const roots = [];
    let node = link;
    for (let depth = 0; depth < 5 && node; depth += 1) {
      roots.push(node);
      node = node.parentElement;
    }
    let best = '';
    let bestScore = -1;
    for (const root of roots) {
      for (const el of root.querySelectorAll('img, image')) {
        const href = upgradeAvatarUrl(profileImageSource(el));
        if (!href || Model.STATIC_HINT.test(href)) continue;
        let rect = el.getBoundingClientRect();
        if (rect.width < 20 && el.parentElement) {
          const parent = el.parentElement.getBoundingClientRect();
          if (parent.width >= 20 && parent.width <= 88) rect = parent;
        }
        const size = Math.min(rect.width, rect.height);
        if (size < 20 || size > 88 || Math.abs(rect.width - rect.height) > 18) continue;
        const inside = link.contains(el);
        const beside = rect.left <= linkBox.left + 8 && linkBox.left - rect.left < 88 && rect.right <= linkBox.right;
        if (!inside && !beside) continue;
        if (Math.abs((rect.top + rect.height / 2) - (linkBox.top + linkBox.height / 2)) > 36) continue;
        const score = size + (beside ? 40 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = href;
        }
      }
      if (best) return best;
    }
    const host = link.parentElement?.parentElement || link.parentElement;
    for (const el of host?.querySelectorAll('div, span, a, i') || []) {
      const rect = el.getBoundingClientRect();
      const size = Math.min(rect.width, rect.height);
      if (size < 24 || size > 80 || Math.abs(rect.width - rect.height) > 14) continue;
      if (Math.abs(rect.top - linkBox.top) > 32 || rect.left > linkBox.left + 4) continue;
      const match = (getComputedStyle(el).backgroundImage || '').match(/url\(["']?(https:[^"')]+)/i);
      const href = match ? upgradeAvatarUrl(match[1]) : '';
      if (href && !Model.STATIC_HINT.test(href)) return href;
    }
    return '';
  }
  function headerAuthor(article) {
    if (!article?.querySelectorAll) return null;
    const media = feedMediaBox(article);
    const host = article.getBoundingClientRect();
    let best = null;
    for (const link of article.querySelectorAll('a[href]')) {
      if (link.closest('#facebook-dl-root, .x-dl-post-entry')) continue;
      const route = Model.routeFromUrl(link.href);
      if (route.kind !== 'profile') continue;
      const box = link.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) continue;
      if (media) {
        if (box.top >= media.top - 4) continue;
      } else if (box.top > host.top + 140) continue;
      const displayName = linkVisibleName(link);
      if (!displayName || displayName.length > 80 || /原声|音频|music|^reel/i.test(displayName)) continue;
      const username = cleanHandle(route.username || Model.usernameFromUrl(link.href)) || route.username || '';
      const score = Math.min(box.width, 220) + Math.max(0, 400 - Math.max(0, box.top - host.top));
      if (!best || score > best.score) best = { score, author: { username, displayName, profileUrl: link.href } };
    }
    return best?.author || null;
  }
  function visiblePageAuthor() {
    const scope = document.querySelector('[role="main"]') || document.body;
    const video = activeReelVideo();
    const videoBox = video?.getBoundingClientRect();
    if (!videoBox) return null;
    let best = null;
    for (const link of scope.querySelectorAll('a[href]')) {
      if (link.closest('#facebook-dl-root, .x-dl-post-entry')) continue;
      const route = Model.routeFromUrl(link.href);
      if (route.kind !== 'profile') continue;
      const label = linkVisibleName(link);
      if (!label || label.length > 80 || /原声|音频|music|^reel/i.test(label)) continue;
      const box = link.getBoundingClientRect();
      if (box.width < 12 || box.height < 10) continue;
      const lower = videoBox.top + videoBox.height * 0.45;
      if (box.bottom < lower || box.top > videoBox.bottom + 4) continue;
      if (box.left < videoBox.left - 12 || box.right > videoBox.right + 80) continue;
      const username = cleanHandle(route.username || Model.usernameFromUrl(link.href));
      const displayName = label;
      if (!username && !displayName) continue;
      const avatar = nearbyReelAvatar(link) || articleAvatarUrl(link.parentElement || link, username) || reelOverlayAvatar();
      const score = (avatar ? 400 : 0) + Math.min(box.width, 120);
      if (!best || score > best.score) best = { score, author: { username, displayName, avatar, profileUrl: link.href } };
    }
    return best?.author || null;
  }
  function ensureVisibleAuthor(post) {
    if (!post) return post;
    const found = isReelPage()
      ? visiblePageAuthor()
      : headerAuthor(viewedPostArticle?.isConnected ? viewedPostArticle : null);
    const current = post.author || {};
    const displayName = personNameFrom(found?.displayName || '') || personNameFrom(current.displayName || '');
    const username = cleanHandle(found?.username || current.username || '') || found?.username || current.username || '';
    if (!found && displayName === personNameFrom(current.displayName || '') && (displayName || '') === (current.displayName || '')) return post;
    if (!displayName && !username) return post;
    const author = {
      ...current,
      ...(found || {}),
      username: username || current.username || '',
      displayName,
      avatar: found?.avatar || current.avatar || '',
      profileUrl: found?.profileUrl || current.profileUrl || ''
    };
    const same = current.displayName === author.displayName && current.username === author.username && current.profileUrl === author.profileUrl;
    if (same && !found) return post;
    return { ...post, author, authors: [author] };
  }
  function genericTitle(post) {
    const title = String(post?.title || '').trim();
    const id = String(post?.shortcode || post?.id || '');
    return !title || title === id || title === 'Post ' + id || /^Post\s+\d/i.test(title);
  }
  function visibleReelCaption(author) {
    const scope = document.querySelector('[role="main"]') || document.body;
    const video = activeReelVideo();
    const videoBox = video?.getBoundingClientRect();
    const skip = new Set([cleanPersonName(author?.displayName), cleanHandle(author?.username)].filter(Boolean).map((value) => value.toLowerCase()));
    const ui = /^(关注|追蹤|Following|Follow|原声|原创音频|音频|翻译|展开|收起|隐藏|隐藏翻译|查看翻译|See more|See less|See translation|Sponsored|赞助|赞助内容|Reels?|赞|评论|分享|发送|Like|Comment|Share|AI\s*内容|AI content)$/i;
    const candidates = [];
    for (const el of scope.querySelectorAll('span, div, h1, h2')) {
      if (el.closest('#facebook-dl-root') || el.tagName === 'BUTTON') continue;
      if ([...el.children].some((child) => cleanPersonName(child.textContent || '').length > 16)) continue;
      let value = cleanPersonName(el.textContent || '');
      value = value.replace(/(?:\.{2,3}|…)+\s*(展开|See more|查看更多)?$/i, '').replace(/\s*(展开|See more|查看更多)$/i, '').trim();
      if (value.length < 2 || value.length > 240) continue;
      if (ui.test(value) || isPresenceLabel(value) || skip.has(value.toLowerCase())) continue;
      if (/原声|原创音频|original audio|AI\s*内容|AI content/i.test(value) && value.length < 48) continue;
      if (/^[\d.,]+\s*[万亿kKmM]?$/.test(value) || /^[#@·•.\s]+$/.test(value)) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 12 || box.height < 8 || box.height > 160) continue;
      if (videoBox) {
        if (box.top < videoBox.top + videoBox.height * 0.35 || box.bottom > videoBox.bottom + 16) continue;
        if (box.left < videoBox.left - 16 || box.left > videoBox.left + videoBox.width * 0.75) continue;
      } else if (box.top < innerHeight * 0.4 || box.top > innerHeight) continue;
      candidates.push({ value, top: box.top });
    }
    candidates.sort((a, b) => (Math.abs(a.top - b.top) > 24 ? b.top - a.top : b.value.length - a.value.length));
    return candidates[0]?.value || '';
  }
  let reelCaptionTimer = 0;
  function scheduleReelCaption() {
    if (reelCaptionTimer) return;
    let tries = 0;
    const tick = () => {
      reelCaptionTimer = 0;
      if (!isReelPage() || !shell.panel?.isOpen?.()) return;
      const source = viewedPost || snapshot.post;
      if (!genericTitle(source)) return;
      if (visibleReelCaption(source?.author)) {
        renderCurrent();
        return;
      }
      if (tries++ < 8) reelCaptionTimer = setTimeout(tick, 300);
    };
    reelCaptionTimer = setTimeout(tick, 200);
  }
  function ensureVisibleTitle(post) {
    if (!post) return post;
    const caption = isReelPage() || genericTitle(post) ? visibleReelCaption(post.author) : '';
    if (caption) return { ...post, title: caption.slice(0, 100), caption };
    return post;
  }
  function syncTabs() {
    const isProfile = snapshot.kind === 'profile' && !viewedPost;
    const hasCreator = Boolean(viewedPost) || isProfile || snapshot.kind === 'post' || Boolean(snapshot.creator?.username || snapshot.post?.author?.username);
    tabsEl.classList.toggle('hidden', isProfile || !hasCreator);
    if (!hasCreator && activeMode === 'creator') activeMode = 'current';
    if (isProfile && activeMode !== 'current' && activeMode !== 'creator') activeMode = 'creator';
    tabsEl.querySelectorAll('[data-mode]').forEach((button) => {
      const active = button.dataset.mode === activeMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    currentBody.classList.toggle('hidden', activeMode !== 'current');
    creatorBody.classList.toggle('hidden', activeMode !== 'creator');
  }

  function previewUrls(media) {
    const images = Model.sortImageCandidates([...(media?.imageCandidates || [])]);
    const preferred = images.filter((item) => (item.width || 0) >= 300 || /name=(?:orig|large)|:orig|:large|video_thumb/i.test(item.url || ''));
    const ordered = [...preferred, ...images];
    const urls = [];
    const seen = new Set();
    function push(url) {
      const href = Model.httpsUrl(url);
      if (!href || seen.has(href)) return;
      seen.add(href);
      urls.push(href);
    }
    // Poster first for videos — raw thumb is most reliable for list covers.
    push(media?.posterUrl);
    ordered.forEach((item) => push(item.url));
    return urls;
  }
  function setMediaPreview(img, media, failed) {
    const urls = previewUrls(media);
    let index = 0;
    img.referrerPolicy = 'strict-origin-when-cross-origin';
    img.addEventListener('error', () => {
      index += 1;
      if (index < urls.length) img.src = urls[index];
      else { img.remove(); failed?.(); }
    });
    if (urls.length) img.src = urls[0];
    else { img.remove(); failed?.(); }
  }
  function coverUrl(post, media) {
    return previewUrls(media)[0] || Model.httpsUrl(post?.author?.avatar || '');
  }

  function showCreatorVideoCover(slot, media, placeholder) {
    if (!['video', 'gif'].includes(media?.type)) return;
    const url = Model.httpsUrl(media?._liveSrc || pickResource(media)?.url || '');
    if (!url) return;
    const video = node(slot, 'video', 'x-creator-cover');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.setAttribute('aria-hidden', 'true');
    video.addEventListener('loadedmetadata', () => {
      // A still frame also covers videos whose thumbnail URL is missing/expired.
      try { video.currentTime = Math.min(0.1, Number.isFinite(video.duration) ? video.duration / 2 : 0.1); } catch (_) {}
    });
    video.addEventListener('loadeddata', () => placeholder.classList.add('hidden'));
    video.addEventListener('error', () => { video.remove(); placeholder.classList.remove('hidden'); });
    video.src = url;
  }

  function activeReelVideo() {
    let best = null;
    let bestScore = 0;
    for (const video of document.querySelectorAll('video')) {
      if (video.closest('#facebook-dl-root')) continue;
      const box = video.getBoundingClientRect();
      const height = Math.min(box.bottom, innerHeight) - Math.max(box.top, 0);
      const width = Math.min(box.right, innerWidth) - Math.max(box.left, 0);
      if (height < 80 || width < 40) continue;
      let score = height * width;
      if (!video.paused && !video.ended) score += 1e9;
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }
    return best;
  }
  const reelFrameState = new WeakMap();
  function captureReelFrame(video) {
    if (!video) return '';
    const state = reelFrameState.get(video);
    if (state?.url) return state.url;
    if (state?.failed) return '';
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return '';
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 720 / video.videoHeight);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    try {
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', 0.82);
      if (!url || url.length < 32) throw new Error('empty frame');
      reelFrameState.set(video, { url });
      return url;
    } catch (_) {
      reelFrameState.set(video, { failed: true });
      return '';
    }
  }
  function armReelFrame(video) {
    if (!video || video.__xDlFrameWatch) return;
    video.__xDlFrameWatch = true;
    video.addEventListener('loadeddata', () => refreshActiveReel(true));
  }
  function reelPosterUrl(video) {
    if (!video) return '';
    const direct = Model.httpsUrl(video.poster || '');
    if (direct) return direct;
    let node = video.parentElement;
    for (let depth = 0; depth < 8 && node && node !== document.body; depth += 1) {
      if (node.querySelectorAll('video').length > 1) break;
      let best = '';
      let bestScore = 0;
      for (const img of node.querySelectorAll('img')) {
        const url = Model.httpsUrl(img.currentSrc || img.src || '');
        if (!url || Model.STATIC_HINT.test(url)) continue;
        const natural = (img.naturalWidth || 0) * (img.naturalHeight || 0);
        const box = img.getBoundingClientRect();
        const visible = Math.max(0, box.width) * Math.max(0, box.height);
        const score = Math.max(natural, visible);
        if (natural < 200 * 200 && visible < 100 * 140) continue;
        if (score > bestScore) {
          bestScore = score;
          best = url;
        }
      }
      if (best) return best;
      node = node.parentElement;
    }
    return '';
  }
  let activeReelKey = '';
  function refreshActiveReel(force) {
    if (!isReelPage() || !shell.panel?.isOpen?.()) return;
    const video = activeReelVideo();
    const key = location.pathname + '|' + (video?.currentSrc || video?.poster || '');
    if (!video || key === '|') return;
    const state = reelFrameState.get(video);
    const settled = Boolean(state?.url || state?.failed);
    const author = visiblePageAuthor();
    const authorKey = [author?.username || '', author?.displayName || '', author?.avatar || ''].join('|');
    const reelKey = key + '|' + authorKey;
    if (!force && reelKey === activeReelKey && settled) return;
    activeReelKey = reelKey;
    renderCurrent();
    if (activeMode === 'creator') renderCreator();
  }
  async function downloadReelCover(post, media) {
    const live = activeReelVideo();
    const frame = captureReelFrame(live) || media?._frame || '';
    if (frame.startsWith('data:')) {
      const filename = await taskFilename(post, { ...media, type: 'image' }, {
        url: frame,
        width: live?.videoWidth || media?.width || 0,
        height: live?.videoHeight || media?.height || 0
      });
      const bytes = await (await fetch(frame)).arrayBuffer();
      await send('FACEBOOK_DL_DOWNLOAD_BYTES', { filename, bytes });
      setStatus(t('addedTasks', { count: 1 }), 'info');
      return;
    }
    const poster = reelPosterUrl(live) || Model.httpsUrl(media?.posterUrl || '');
    if (!poster) {
      setStatus(t('noCover'), 'warn');
      return;
    }
    await enqueueMedia(post, [coverMediaFrom({ ...media, posterUrl: poster, imageCandidates: [{ url: poster, source: 'poster' }] })]);
  }
  function renderCurrent() {
    currentBody.replaceChildren();
    const post = currentPost();
    if (isReelPage() && genericTitle(post)) scheduleReelCaption();
    if (snapshot.kind === 'post' && post && !isReelPage()) {
      button(currentBody, t(threadScanning ? 'batchStopThread' : 'batchThread'), 'x-mini-button', () => {
        if (threadScanning) { threadScanToken += 1; threadScanning = false; renderView(); }
        else downloadThread().catch(error => setStatus(error.message,'error'));
      });
      node(currentBody, 'p', 'x-muted', t('batchThreadHint'));
    }
    if (snapshot.kind === 'unsupported') {
      node(currentBody, 'p', 'x-empty-inline', t('unsupportedPage'));
      return;
    }
    if (snapshot.kind === 'profile' && !viewedPost) {
      node(currentBody, 'p', 'x-empty-inline', t('creatorPageDetail'));
      button(currentBody, t('profileBatch'), 'x-dl-btn', () => { activeMode = 'creator'; syncTabs(); renderView(); });
      return;
    }
    if (!post?.media?.length) {
      node(currentBody, 'p', 'x-dl-video-title', t('waitPost'));
      node(currentBody, 'p', 'x-muted', t('waitPostDetail'));
      return;
    }
    const selectionPost = post.shortcode || post.id || post.pageUrl;
    if (post.media.length > 1 && mediaSelectionPost !== selectionPost) {
      mediaSelectionPost = selectionPost;
      selectedMedia = new Set(post.media.map((item) => downloadKey(post, item)));
    }
    const reel = isReelPage();
    const card = node(currentBody, 'div', 'x-dl-video-card' + (reel ? ' is-reel-card' : ''));
    const first = post.media[0];
    if (reel && first) {
      const live = activeReelVideo();
      armReelFrame(live);
      const frame = captureReelFrame(live);
      const poster = reelPosterUrl(live);
      const key = location.pathname + '|' + (live?.currentSrc || live?.poster || '');
      if (live && key !== '|') activeReelKey = key;
      if (frame) first._frame = frame;
      if (poster) {
        first.posterUrl = poster;
        first.imageCandidates = [{ url: poster, source: 'poster' }];
      }
      const coverCol = node(card, 'div', 'x-dl-cover-column');
      const wrap = node(coverCol, 'div', 'x-dl-cover-wrap is-reel');
      const img = node(wrap, 'img', 'x-dl-cover');
      img.alt = '';
      img.referrerPolicy = 'strict-origin-when-cross-origin';
      if (frame) img.src = frame;
      else {
        setMediaPreview(img, first, () => {
          const placeholder = node(wrap, 'div', 'x-dl-cover-ph');
          if (first.type === 'video') showCreatorVideoCover(wrap, first, placeholder);
        });
      }
      button(coverCol, t('feedPostEntry'), 'x-dl-cover-download', () => {
        downloadReelCover(post, first).catch((error) => setStatus(error.message, 'error'));
      });
    } else {
      const coverCol = node(card, 'div', 'x-dl-cover-column');
      const wrap = node(coverCol, 'div', 'x-dl-cover-wrap');
      const shape = postCoverShape(first);
      if (shape) wrap.classList.add(shape);
      else if (pageType(post) === 'video' || pageType(post) === 'gif') wrap.classList.add('is-reel');
      const img = node(wrap, 'img', 'x-dl-cover');
      img.referrerPolicy = 'strict-origin-when-cross-origin';
      setMediaPreview(img, first, () => {
        const placeholder = node(wrap, 'div', 'x-dl-cover-ph');
        if (first?.type === 'video') showCreatorVideoCover(wrap, first, placeholder);
      });
      if (first?.type === 'video' && (first.posterUrl || first.imageCandidates?.length)) {
        button(coverCol, t('feedPostEntry'), 'x-dl-cover-download', () => enqueueMedia(post, [coverMediaFrom(first)]));
      }
    }
    const side = node(card, 'div', 'x-dl-video-side');
    const content = node(side, 'div', 'x-dl-video-content');
    node(content, 'div', 'x-dl-video-title', post.title || t('facebookPost'));
    const authorLine = node(content, 'div', 'x-dl-video-author');
    const authors = post.authors?.length ? post.authors : [post.author];
    authors.forEach((author) => {
      const label = authorLabel(author);
      const handle = cleanHandle(author?.username || '');
      if (!label) return;
      const authorLink = node(authorLine, 'a', 'x-dl-author-link', label);
      authorLink.href = author?.profileUrl || (handle ? Model.profileUrl(handle) : location.href);
      authorLink.title = label;
    });
    if (!authorLine.childNodes?.length) authorLine.remove?.();
    const sub = node(content, 'div', 'x-dl-video-sub', [pageTypeLabel(post), t('mediaCount', { count: post.media.length })].filter(Boolean).join(' · '));
    if (post.shortcode) sub.title = post.shortcode;

    if (post.media.length === 1) {
      const media = post.media[0];
      const resource = pickResource(media);
      if (!resource?.url) {
        node(currentBody, 'p', 'x-resource-unavailable', t(viewedPostLoading ? 'feedResolving' : 'noResource'));
        const retry = button(currentBody, t('rescan'), 'x-mini-button', () => {
          if (viewedPost && viewedPostArticle) { openFeedPost(viewedPostArticle, post.pageUrl).catch((error) => setStatus(error.message, 'error')); return; }
          requestResolve([{ pageUrl: post.pageUrl || location.href, shortcode: post.shortcode, kind: post.kind }]);
          setStatus(t('waitPost'), 'info');
        });
        retry.disabled = viewedPostLoading;
      } else {
        const previewName = node(currentBody, 'p', 'x-dl-filename-preview');
        const previewLabel = node(previewName, 'span', 'x-dl-filename-preview-label', t('saveAs'));
        const previewValue = node(previewName, 'span', 'x-dl-filename-preview-name', t('filenameLoading'));
        taskFilename(post, media, resource).then((name) => {
          previewLabel.textContent = t('saveAs');
          previewValue.textContent = name;
          previewName.title = name;
        }).catch(() => {});
        if (media.type === 'video') button(currentBody, t('downloadVideo'), 'x-dl-btn x-dl-start', () => enqueueMedia(post, [media]));
        else button(currentBody, t('downloadImage'), 'x-dl-btn x-dl-start', () => enqueueMedia(post, [media]));
      }
      if (post.quotedMedia?.length) {
        button(currentBody, t('downloadQuotedMedia', { count: post.quotedMedia.length }), 'x-mini-button', () => {
          enqueueMedia(post, post.quotedMedia);
        });
      }
    } else {
      const tools = node(currentBody, 'div', 'x-list-toolbar');
      button(tools, t('selectAllShort'), 'x-mini-button', () => { selectedMedia = new Set(post.media.map((item) => downloadKey(post, item))); renderCurrent(); });
      button(tools, t('selectNewShort'), 'x-mini-button', async () => {
        const selectionToken = viewedPostToken;
        const done = await completedKeys();
        if (viewedPostToken !== selectionToken || currentPost()?.shortcode !== post.shortcode) return;
        selectedMedia = new Set(post.media.filter((item) => !done.has(downloadKey(post, item))).map((item) => downloadKey(post, item)));
        renderCurrent();
      });
      button(tools, t('clearShort'), 'x-mini-button', () => { selectedMedia = new Set(); renderCurrent(); });
      if (!creatorReady(post)) node(currentBody, 'p', 'x-resource-unavailable', t(viewedPostLoading ? 'feedResolving' : 'incompleteCarousel'));
      const grid = node(currentBody, 'div', 'x-media-grid');
      post.media.forEach((media) => {
        const key = downloadKey(post, media);
        const row = node(grid, 'label', 'x-media-item');
        const check = node(row, 'input', 'x-checkbox');
        check.type = 'checkbox';
        check.checked = selectedMedia.has(key);
        check.addEventListener('change', () => {
          if (check.checked) selectedMedia.add(key);
          else selectedMedia.delete(key);
          bar.textContent = t('selectedOf', { selected: selectedMedia.size, total: post.media.length });
          download.disabled = selectedMedia.size === 0;
        });
        const shape = postCoverShape(media);
        const thumb = node(row, 'img', 'x-media-thumb' + (shape ? ' ' + shape : ''));
        setMediaPreview(thumb, media, () => node(row, 'span', 'x-media-thumb x-dl-cover-ph')); 
        node(row, 'span', 'x-media-meta', (media.index + ' / ' + post.media.length) + ' · ' + (media.type === 'video' ? t('pageTypeVideo') : t('pageTypeImage')) + (media.width ? ' · ' + media.width + 'x' + media.height : ''));
      });
      const bar = node(currentBody, 'div', 'x-dl-filename-preview', t('selectedOf', { selected: selectedMedia.size, total: post.media.length }));
      const download = button(currentBody, t('downloadSelected'), 'x-dl-btn x-dl-start', () => {
        const items = post.media.filter((item) => selectedMedia.has(downloadKey(post, item)));
        enqueueMedia(post, items);
      });
      download.disabled = selectedMedia.size === 0;
      if (post.quotedMedia?.length) {
        button(currentBody, t('downloadQuotedMedia', { count: post.quotedMedia.length }), 'x-mini-button', () => {
          enqueueMedia(post, post.quotedMedia);
        });
      }
    }
  }

  function mergeCreatorPosts(list, target = creatorPosts) {
    (Array.isArray(list) ? list : []).forEach((post) => {
      const key = post.shortcode || post.id;
      if (!key) return;
      const cached = resourceCache.get(key);
      if (cached && Date.now() - cached.resolvedAt < RESOURCE_TTL) post = { ...post, ...cached };
      const previous = target.get(key);
      const previousMedia = Array.isArray(previous?.media) ? previous.media : [];
      const incomingMedia = Array.isArray(post.media) ? post.media : [];
      const media = incomingMedia.map((item) => {
        const existing = previousMedia.find((candidate) => candidate.id === item.id || candidate.index === item.index) || {};
        const hasResource = Boolean(item.imageCandidates?.length || item.videoCandidates?.length);
        return {
          ...existing,
          ...item,
          type: hasResource ? item.type : (existing.type || item.type),
          posterUrl: item.posterUrl || existing.posterUrl || '',
          imageCandidates: item.imageCandidates?.length ? item.imageCandidates : (existing.imageCandidates || []),
          videoCandidates: item.videoCandidates?.length ? item.videoCandidates : (existing.videoCandidates || [])
        };
      });
      previousMedia.forEach((item) => {
        if (!media.some((candidate) => candidate.id === item.id || candidate.index === item.index)) media.push(item);
      });
      const fallbackTitle = !post.title || post.title === key || /^Post\s/i.test(post.title);
      const title = fallbackTitle && previous?.title ? previous.title : (post.title || key);
      target.set(key, {
        ...previous,
        ...post,
        id: post.id === key && previous?.id ? previous.id : post.id,
        kind: incomingMedia.some((item) => item.imageCandidates?.length || item.videoCandidates?.length)
          ? post.kind : (previous?.kind || post.kind),
        title,
        publishTime: post.publishTime || previous?.publishTime || '',
        pinned: post.onPage ? Boolean(post.pinned) : Boolean(post.pinned || previous?.pinned),
        timelineIndex: post.onPage
          ? post.timelineIndex
          : (Number.isFinite(post.timelineIndex) ? post.timelineIndex
            : (Number.isFinite(previous?.timelineIndex) ? previous.timelineIndex : undefined)),
        onPage: post.onPage === true ? true : (post.onPage === false ? false : Boolean(previous?.onPage)),
        pageUrl: post.pageUrl || previous?.pageUrl || '',
        author: { ...(previous?.author || {}), ...(post.author || {}) },
        authors: [...(post.authors || []), ...(previous?.authors || [])].filter((author, index, list) =>
          author?.username && list.findIndex((other) => other?.username?.toLowerCase() === author.username.toLowerCase()) === index),
        media
      });
    });
    while (target.size > 1000) {
      const oldest = target.keys().next().value;
      target.delete(oldest);
      for (const ids of creatorCategories.values()) ids.delete(oldest);
    }
  }

  function creatorPostRoute(url) {
    const route = Model.routeFromUrl(url.href || url);
    if (route.kind !== 'post' || !route.shortcode) return null;
    return route;
  }

  function creatorPostCard(link) {
    let card = link;
    let parent = link.parentElement;
    for (let index = 0; index < 8 && parent; index += 1) {
      const links = parent.querySelectorAll('a[href*="/posts/"], a[href*="/videos/"], a[href*="/reel"], a[href*="/watch/"]');
      if (links.length > 1) break;
      card = parent;
      parent = parent.parentElement;
    }
    return card;
  }

  function imageFromNode(element) {
    if (!element) return '';
    const image = element.matches?.('img') ? element : element.querySelector?.('img');
    const srcset = image?.getAttribute('srcset') || '';
    const candidates = srcset.split(',').map((item) => item.trim().split(/\s+/)[0]).filter(Boolean);
    const direct = image?.currentSrc || image?.src || candidates[candidates.length - 1] || '';
    if (direct) return Model.httpsUrl(direct);
    const styled = [element, ...element.querySelectorAll?.('[style*="background-image"]') || []];
    for (const item of styled) {
      const value = item.style?.backgroundImage || getComputedStyle(item).backgroundImage || '';
      const match = value.match(/^url\(["']?(.*?)["']?\)$/i);
      if (match?.[1]) return Model.httpsUrl(match[1]);
    }
    return '';
  }

  function isPlaceholderTitle(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return !text || /方块预览|方塊預覽|tile preview|preview tile|^reels?(?:\s+preview)?$/i.test(text);
  }
  function reelTileCaption(link) {
    let best = '';
    for (const el of link.querySelectorAll('span')) {
      if (el.children.length) continue;
      const value = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      if (value.length < 2 || value.length > 140 || isPlaceholderTitle(value)) continue;
      if (/^[\d,.\s]+(?:\s*[万亿kKmM])?$/.test(value)) continue;
      if (value.length > best.length) best = value;
    }
    return best;
  }
  function tileCoverImage(link) {
    const host = link.getBoundingClientRect();
    let best = null;
    let bestArea = 0;
    for (const img of link.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      if (!src || Model.looksLikeAvatar(src) || Model.STATIC_HINT.test(src)) continue;
      const box = img.getBoundingClientRect();
      const width = box.width || img.clientWidth || 0;
      const height = box.height || img.clientHeight || 0;
      if (width < Math.max(48, host.width * 0.45) || height < Math.max(48, host.height * 0.35)) continue;
      const area = width * height;
      if (area > bestArea) {
        bestArea = area;
        best = img;
      }
    }
    return best;
  }
  function creatorPostTitle(link, card, image, shortcode) {
    const tileCaption = link ? reelTileCaption(link) : '';
    if (tileCaption) return tileCaption.slice(0, 120);
    const tweetText = card?.querySelector?.('[data-ad-preview="message"], [data-ad-comet-preview="message"]')?.innerText
      || link?.closest?.('[role="article"]')?.querySelector?.('[data-ad-preview="message"]')?.innerText;
    if (tweetText) {
      const line = String(tweetText).replace(/\s+/g, ' ').trim().slice(0, 120);
      if (line && !isPlaceholderTitle(line)) return line;
    }
    const candidates = [link?.getAttribute?.('aria-label'), link?.getAttribute?.('title'), image?.alt];
    for (const candidate of candidates) {
      const value = String(candidate || '').trim();
      if (value && value.length <= 500 && !/^tweet\b/i.test(value) && !isPlaceholderTitle(value)) return value;
    }
    return t('facebookPostFallback', { id: shortcode });
  }

  function isPinnedArticle(article) {
    const heading = article.querySelector('h2, h3, h4, [role="heading"]');
    const label = String(heading?.textContent || '').replace(/\s+/g, ' ').trim();
    return /置顶|Pinned|Featured/i.test(label);
  }

  function scanDomCreatorPosts() {
    if (Model.routeFromUrl(location.href).kind !== 'profile') return;
    const username = String(snapshot.creator?.username || Model.routeFromUrl(location.href).username || '').replace(/^@/, '');
    if (!username) return;
    const posts = [];
    const seen = new Set();
    const category = creatorCategory();
    if (!creatorCategories.has(category)) creatorCategories.set(category, new Set());
    const ids = creatorCategories.get(category);
    const previousOrder = [...ids];
    // Clear stale page-order: scrolled-away tweets must not keep old top indices.
    for (const id of ids) {
      const post = creatorPosts.get(id);
      if (!post) continue;
      post.timelineIndex = undefined;
      post.onPage = false;
    }
    const main = document.querySelector('[role="main"]') || document;
    const tab = profileTab();
    const sources = tab === 'reels' ? [] : [...main.querySelectorAll('[role="article"]')]
      .filter((article) => !article.closest('#facebook-dl-root') && profileArticleCollectible(article))
      .map((article) => ({ article, link: null, tile: false }));
    if (tab === 'photos' || tab === 'reels') {
      const selector = tab === 'photos'
        ? 'a[href*="/photo"], a[href*="fbid="], a[href*="/photos/"]'
        : 'a[href*="/reel"]';
      const links = [...main.querySelectorAll(selector)].filter((link) => {
        if (link.closest('#facebook-dl-root')) return false;
        if (tab !== 'reels' && link.closest('[role="article"]')) return false;
        const box = link.getBoundingClientRect();
        if (tab === 'reels') return box.width >= 80 && box.height >= 110 && box.height >= box.width * 0.85;
        return box.width >= 64 && box.height >= 64;
      });
      links.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        if (Math.abs(ra.top - rb.top) > 28) return ra.top - rb.top;
        return ra.left - rb.left;
      });
      links.filter((link) => !links.some((other) => other !== link && other.contains(link))).forEach((link) => {
        sources.push({ article: link, link, tile: tab === 'reels' });
      });
    }
    let timelineIndex = 0;
    for (const source of sources) {
      const article = source.article;
      if (seen.size >= 300) break;
      const postLink = source.link || [...article.querySelectorAll('a[href]')].find((link) => {
        try {
          const linked = Model.routeFromUrl(link.href);
          if (linked.kind !== 'post' || !linked.shortcode) return false;
          if (!linked.username) return true;
          return linked.username.toLowerCase() === username.toLowerCase();
        } catch (_) { return false; }
      });
      if (!postLink) continue;
      let url;
      try { url = new URL(postLink.href, location.href); } catch (_) { continue; }
      const route = creatorPostRoute(url);
      if (!route?.shortcode || seen.has(route.shortcode)) continue;
      seen.add(route.shortcode);
      ids.add(route.shortcode);
      const order = timelineIndex;
      timelineIndex += 1;
      const pinned = isPinnedArticle(article);
      const existing = creatorPosts.get(route.shortcode);
      const card = creatorPostCard(postLink) || article;
      const image = source.tile ? tileCoverImage(article) : ([...article.querySelectorAll('img')].find((img) => {
          const src = img.currentSrc || img.src || '';
          return src && !Model.looksLikeAvatar(src) && !Model.STATIC_HINT.test(src) && (img.naturalWidth || img.clientWidth || 0) >= 64;
        })
        || postLink.querySelector('img')
        || card.querySelector('img'));
      const videoEl = source.tile ? null : article.querySelector('video');
      const posterUrl = Model.allowedMediaUrl(videoEl?.poster || '')
        || imageFromNode(image)
        || imageFromNode(article)
        || imageFromNode(card);
      const title = creatorPostTitle(postLink, article, image, route.shortcode);
      const timeEl = article.querySelector('time[datetime]');
      let publishTime = '';
      if (timeEl?.dateTime) {
        const parsed = Date.parse(timeEl.dateTime);
        if (Number.isFinite(parsed)) publishTime = new Date(parsed).toISOString();
      }
      const pageUrl = Model.permalinkUrl({ shortcode: route.shortcode, pageUrl: url.href, author: { username: route.username || username } });
      const imageCandidates = [];
      const allowedPoster = Model.allowedMediaUrl(posterUrl);
      if (allowedPoster) {
        const variants = [
          Model.origImageUrl(allowedPoster),
          Model.sizedImageUrl ? Model.sizedImageUrl(allowedPoster, 'large') : '',
          allowedPoster
        ].filter(Boolean);
        variants.forEach((url) => {
          if (!imageCandidates.some((item) => item.url === url)) {
            imageCandidates.push({
              url, mime: 'image/jpeg', width: 0, height: 0, bitrate: 0, sizeBytes: 0, source: 'dom', backupUrls: []
            });
          }
        });
      }
      const media = existing?.media?.length ? existing.media.map((item, index) => {
        if (index !== 0) return item;
        const next = { ...item };
        if (posterUrl && !next.posterUrl) next.posterUrl = allowedPoster || posterUrl;
        if (imageCandidates.length && !(next.imageCandidates || []).length) next.imageCandidates = imageCandidates;
        return next;
      }) : [{
        id: route.shortcode + '-1',
        index: 1,
        type: source.tile || article.querySelector('video') ? 'video' : 'image',
        posterUrl: allowedPoster || posterUrl || '',
        imageCandidates,
        videoCandidates: []
      }];
      // Skip pure-text stubs (no poster / candidates) — same rule as feed download button.
      if (!media.some((item) => item.imageCandidates?.length || item.videoCandidates?.length || Model.allowedMediaUrl(item.posterUrl || '') || item.type === 'video')) continue;
      posts.push({
        id: route.shortcode,
        shortcode: route.shortcode,
        pageUrl: existing?.pageUrl || pageUrl,
        title: title || existing?.title || route.shortcode,
        kind: source.tile ? 'video' : (existing?.kind || (article.querySelector('video') ? 'video' : 'image')),
        publishTime: publishTime || existing?.publishTime || '',
        pinned,
        timelineIndex: order,
        onPage: true,
        author: { username, avatar: upgradeAvatarUrl(snapshot.creator?.avatar || existing?.author?.avatar || '') },
        media
      });
    }
    mergeCreatorPosts(posts);
    const overlap = previousOrder.some((id) => seen.has(id));
    const ordered = tab === 'reels' && seen.size
      ? [...seen, ...previousOrder.filter((id) => !seen.has(id) && postMatchesProfileTab(creatorPosts.get(id)))]
      : (overlap || !seen.size ? mergePageOrder(previousOrder, [...seen]) : [...seen]);
    creatorCategories.set(category, new Set(ordered.filter((id) => postHasMedia(creatorPosts.get(id)))));
    pruneTextOnlyCreatorPosts(category);
  }

  function visibleCreatorPosts() {
    return filteredCreatorPosts().slice(0, creatorVisibleLimit);
  }

  function creatorReady(post) {
    return !post.isPartial && (!post.resolvedAt || Date.now() - post.resolvedAt < RESOURCE_TTL) && Boolean(post.media?.length) && (!post.expectedMediaCount || post.media.length >= post.expectedMediaCount) && post.media.every((item) => Boolean(pickResource(item)?.url));
  }

  async function refreshCreatorPosts(manual = true) {
    if (snapshot.kind !== 'profile' || creatorPreparing) return;
    const key = creatorKey;
    const category = creatorCategory();
    const target = creatorPosts;
    const token = ++creatorPrepareToken;
    try {
      await resourceCacheReady;
      if (token !== creatorPrepareToken || creatorKey !== key || creatorCategory() !== category) return;
      scanDomCreatorPosts();
      const candidates = manual ? filteredCreatorPosts() : visibleCreatorPosts();
      await loadResourceCache(candidates);
      if (token !== creatorPrepareToken || creatorKey !== key || creatorCategory() !== category) return;
      const pending = candidates.map(post => target.get(post.shortcode || post.id) || post).filter((post) => !creatorReady(post) &&
        (manual || !creatorAutoAttempts.has(key + ':' + post.shortcode)));
      // Auto-resolve with nothing left: exit quietly so Refresh list does not flash.
      if (!manual && !pending.length) return;
      creatorPreparing = true;
      renderCreator();
      if (!manual) pending.forEach(post => creatorAutoAttempts.set(key + ':' + post.shortcode, true));
      for (let offset = 0; offset < pending.length; offset += 2) {
        if (token !== creatorPrepareToken || creatorKey !== key || creatorCategory() !== category || snapshot.kind !== 'profile') break;
        const batch = pending.slice(offset, offset + 2);
        setStatus(t('creatorResolveProgress', { current: offset + batch.length, total: pending.length }), 'info');
        const epoch = requestResolve(batch.map((post) => ({ pageUrl: post.pageUrl, shortcode: post.shortcode, kind: post.kind })));
        await waitForResolve(epoch, batch.length);
        const unresolved = batch.filter((post) => !creatorReady(target.get(post.shortcode || post.id) || post));
        if (manual && token === creatorPrepareToken && creatorCategory() === category) await Promise.all(unresolved.map(async (post) => {
          const result = await resolveCreatorDetail(post).catch(() => null);
          if (result?.post && token === creatorPrepareToken && creatorKey === key && creatorCategory() === category) {
            cacheResolved(result.post, target);
            if (creatorPosts === target && snapshot.kind === 'profile') renderCreator();
          }
        }));
        if (token !== creatorPrepareToken || creatorKey !== key || snapshot.kind !== 'profile') break;
        pruneTextOnlyCreatorPosts(category);
        renderCreator();
      }
    } finally {
      if (token !== creatorPrepareToken) return;
      pruneTextOnlyCreatorPosts(category);
      const wasPreparing = creatorPreparing;
      creatorPreparing = false;
      if (wasPreparing) renderCreator();
      if (creatorKey === key && wasPreparing) setStatus(t('creatorPrepared', {
        ready: filteredCreatorPosts().filter(creatorReady).length, total: filteredCreatorPosts().length
      }), 'info');
      // Only continue auto-resolve when new unresolved posts still need a first attempt.
      if (snapshot.kind === 'profile' && unresolvedAutoPosts().length) scheduleCreatorResolve();
    }
  }

  function formatPostDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value).slice(0, 10);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  function upgradeAvatarUrl(url) {
    const href = Model.httpsUrl(url);
    if (!href) return '';
    const bump = (value) => String(value || '').replace(/([sp])(\d{2,4})x(\d{2,4})/gi, (token, kind, width, height) => {
      if (Number(width) >= 480 || Number(height) >= 480) return token;
      return kind + '720x720';
    });
    try {
      const parsed = new URL(href);
      ['stp', 'cstp', 'ctp'].forEach((key) => {
        if (parsed.searchParams.has(key)) parsed.searchParams.set(key, bump(parsed.searchParams.get(key)));
      });
      return parsed.href;
    } catch (_) {
      return href;
    }
  }

  function profileImageSource(el) {
    const animated = el.href && typeof el.href === 'object' ? el.href.baseVal : '';
    let best = '';
    let bestScale = 0;
    for (const part of String(el.srcset || el.getAttribute?.('srcset') || '').split(',')) {
      const bits = part.trim().split(/\s+/);
      const scale = /w$/i.test(bits[1] || '') ? parseFloat(bits[1]) / 160 : (parseFloat(bits[1]) || 1);
      if (bits[0] && scale >= bestScale) {
        bestScale = scale;
        best = bits[0];
      }
    }
    return best || el.currentSrc || el.src || animated
      || el.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href')
      || el.getAttribute('xlink:href')
      || el.getAttribute('href')
      || '';
  }
  function articleAvatarUrl(article, username) {
    if (!article) return '';
    const host = article.getBoundingClientRect();
    const name = String(username || '').replace(/^@/, '').trim().toLowerCase();
    const scopes = [];
    if (name) {
      const link = [...article.querySelectorAll('a[href]')].find((el) => {
        if (el.closest('.x-dl-post-entry')) return false;
        return Model.usernameFromUrl(el.href || '').toLowerCase() === name;
      });
      if (link) scopes.push(link);
    }
    scopes.push(article);
    for (const scope of scopes) {
      let best = '';
      let bestScore = -1;
      for (const el of scope.querySelectorAll('img, image')) {
        if (el.closest('.x-dl-post-entry, #facebook-dl-root')) continue;
        const href = upgradeAvatarUrl(profileImageSource(el));
        if (!href || Model.STATIC_HINT.test(href)) continue;
        let rect = el.getBoundingClientRect();
        let node = el;
        for (let depth = 0; depth < 3 && rect.width < 24; depth += 1) {
          node = node.parentElement;
          if (!node || !scope.contains(node)) break;
          const next = node.getBoundingClientRect();
          if (next.width > 96 || next.height > 96 || Math.abs(next.width - next.height) > 20) break;
          rect = next;
        }
        if (rect.width < 24 || rect.height < 24 || rect.width > 96 || rect.height > 96) continue;
        if (Math.abs(rect.width - rect.height) > 16) continue;
        if (scope === article && rect.top - host.top > 110) continue;
        const score = Math.min(rect.width, rect.height) + (scope === article ? 0 : 200);
        if (score > bestScore) {
          bestScore = score;
          best = href;
        }
      }
      if (!best && scope !== article) {
        const nodes = [scope, ...scope.querySelectorAll('div, span')].slice(0, 8);
        for (const el of nodes) {
          const match = (getComputedStyle(el).backgroundImage || '').match(/url\(["']?(https:[^"')]+)/i);
          const href = match ? upgradeAvatarUrl(match[1]) : '';
          if (href && !Model.STATIC_HINT.test(href)) return href;
        }
      }
      if (best) return best;
    }
    return '';
  }
  function profileImageBox(el) {
    let node = el;
    for (let depth = 0; depth < 4 && node; depth += 1) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= 48 && rect.height >= 48) return rect;
      node = node.parentElement;
    }
    return el.getBoundingClientRect();
  }
  function profileHeaderDetails() {
    let avatar = upgradeAvatarUrl(snapshot.creator?.avatar || '');
    const header = document.querySelector('[role="main"]');
    const mainTop = header?.getBoundingClientRect().top || 0;
    let bestScore = -1;
    for (const el of header?.querySelectorAll('img, image') || []) {
      if (el.closest('#facebook-dl-root, [role="article"], .x-dl-post-entry')) continue;
      const href = upgradeAvatarUrl(profileImageSource(el));
      if (!href || Model.STATIC_HINT.test(href)) continue;
      const rect = profileImageBox(el);
      const width = rect.width || 0;
      const height = rect.height || 0;
      if (width < 72 || height < 72 || width > 260 || height > 260) continue;
      if (Math.abs(width - height) > Math.max(width, height) * 0.35) continue;
      if (rect.top - mainTop > 560) continue;
      const score = Math.min(width, height);
      if (score > bestScore) {
        bestScore = score;
        avatar = href;
      }
    }
    const textBlob = String(header?.innerText || '').slice(0, 2500);
    const match = textBlob.match(/([\d,.]+)\s*(?:posts|帖子|位好友|friends)/i);
    const total = match ? Number(match[1].replace(/[,.]/g, '')) : 0;
    return { avatar, total };
  }

  let creatorViewRendered = '';
  function creatorViewKey() {
    const rows = visibleCreatorPosts().map((post) => [
      post.shortcode || post.id || '',
      post.title || '',
      post.kind || '',
      post.media?.[0]?.type || '',
      post.media?.[0]?.posterUrl || '',
      creatorReady(post) ? 1 : 0
    ].join('\u001f'));
    const post = snapshot.kind === 'profile' ? null : ensureVisibleAuthor(viewedPost || snapshot.post);
    const author = post?.author || {};
    const avatar = isReelPage()
      ? (reelOverlayAvatar() || author.avatar || '')
      : (author.avatar || articleAvatarUrl(viewedPostArticle, author.username) || '');
    const identity = [post?.shortcode || post?.id || '', author.username || '', author.displayName || '', avatar].join('|');
    return [creatorKey, profileTab(), creatorPreparing ? 1 : 0, creatorVisibleLimit, selectedPosts.size, identity, rows.join('\u001e')].join('#');
  }
  function renderCreator() {
    const viewKey = creatorViewKey();
    if (viewKey === creatorViewRendered && creatorBody.childElementCount) return;
    creatorViewRendered = viewKey;
    const scrollTop = creatorBody.querySelector('.x-creator-list')?.scrollTop || 0;
    creatorBody.replaceChildren();
    Object.assign(creatorFilters, { type: 'all', from: '', to: '', min: '', max: '', limit: '' });
    const availableIds = new Set(filteredCreatorPosts().map(post => post.shortcode || post.id));
    selectedPosts = new Set([...selectedPosts].filter(id => availableIds.has(id)));
    if (snapshot.kind !== 'profile') {
      const post = ensureVisibleAuthor(viewedPost || snapshot.post);
      if (post && !viewedPost) snapshot.post = post;
      const authors = (post?.authors?.length ? post.authors : [post?.author || snapshot.creator])
        .filter((author, index, list) => author?.username && list.findIndex((other) =>
          other?.username?.toLowerCase() === author.username.toLowerCase()) === index);
      const gate = node(creatorBody, 'section', 'x-creator-gate');
      const primary = authors[0] || post?.author || {};
      const avatarUrl = upgradeAvatarUrl(primary.avatar || post?.author?.avatar || '')
        || (isReelPage() ? reelOverlayAvatar() : '')
        || articleAvatarUrl(viewedPostArticle, primary.username);
      const avatar = node(gate, 'div', avatarUrl ? 'x-creator-avatar' : 'x-creator-gate-icon');
      if (avatarUrl) {
        const img = node(avatar, 'img', '');
        img.alt = '';
        img.referrerPolicy = 'strict-origin-when-cross-origin';
        img.decoding = 'async';
        const plainAvatar = Model.httpsUrl(primary.avatar || post?.author?.avatar || '');
        img.addEventListener('error', () => {
          if (plainAvatar && img.src !== plainAvatar) {
            img.src = plainAvatar;
            return;
          }
          img.remove();
          avatar.className = 'x-creator-avatar';
          avatar.textContent = (primary.username || 'I').slice(0, 1).toUpperCase();
        });
        img.src = avatarUrl;
      } else avatar.textContent = '◎';
      node(gate, 'div', 'x-dl-video-title', t('creator'));
      node(gate, 'p', 'x-muted', t('creatorGoProfile'));
      authors.forEach((author) => {
        const label = authorLabel(author);
        const handle = cleanHandle(author?.username || '');
        if (!label) return;
        const entry = button(gate, label, 'x-dl-btn x-creator-profile-entry', () => {
          location.href = author.profileUrl || (handle ? Model.profileUrl(handle) : location.href);
        });
        entry.setAttribute('aria-label', label + ' · ' + t('creatorGoProfile'));
      });
      return;
    }
    const profile = snapshot.creator || {};
    const headerDetails = profileHeaderDetails();
    const summary = node(creatorBody, 'section', 'x-creator-summary');
    const main = node(summary, 'div', 'x-creator-main');
    const avatar = node(main, 'div', 'x-creator-avatar');
    const avatarUrl = headerDetails.avatar || upgradeAvatarUrl(profile.avatar || '');
    if (avatarUrl) {
      const img = node(avatar, 'img', '');
      img.alt = '';
      img.referrerPolicy = 'strict-origin-when-cross-origin';
      img.decoding = 'async';
      const plainAvatar = Model.httpsUrl(profile.avatar || '');
      img.addEventListener('error', () => {
        if (plainAvatar && img.src !== plainAvatar) {
          img.src = plainAvatar;
          return;
        }
        img.remove();
        avatar.textContent = (profile.username || 'I').slice(0, 1).toUpperCase();
      });
      img.src = avatarUrl;
    } else avatar.textContent = (profile.username || 'I').slice(0, 1).toUpperCase();
    const identity = node(main, 'div', 'x-creator-identity');
    const username = String(profile.username || '').trim();
    const displayName = String(profile.displayName || '').trim();
    node(identity, 'strong', '', username ? '@' + username : (displayName || t('creator')));
    node(identity, 'span', 'x-count', categoryPosts().length
      ? t('creatorPrepared', { ready: filteredCreatorPosts().filter(creatorReady).length, total: filteredCreatorPosts().length })
      : t('scanReady'));
    const refresh = button(summary, t(creatorPreparing ? 'creatorPreparing' : 'refreshPosts'), 'x-mini-button x-scan-btn', () => refreshCreatorPosts().catch((error) => setStatus(error.message, 'error')));
    refresh.disabled = creatorPreparing;
    const tools = node(creatorBody, 'div', 'x-list-toolbar');
    node(tools, 'span', 'x-list-count', t('batchPostCount', { count: filteredCreatorPosts().length }));
    const toolActions = node(tools, 'div', 'x-list-actions');
    button(toolActions, t('selectAllShort'), 'x-mini-button', () => { selectedPosts = new Set(visibleCreatorPosts().map((item) => item.shortcode || item.id)); renderCreator(); });
    button(toolActions, t('selectNewShort'), 'x-mini-button', async () => {
      const target = creatorPosts;
      const key = creatorKey;
      const done = await completedKeys();
      if (target !== creatorPosts || key !== creatorKey) return;
      selectedPosts = new Set(visibleCreatorPosts().filter((post) => !creatorItems(post).every((media) => done.has(downloadKey(post, media)))).map((item) => item.shortcode || item.id));
      renderCreator();
    });
    button(toolActions, t('clearShort'), 'x-mini-button', () => { selectedPosts = new Set(); renderCreator(); });
    const list = node(creatorBody, 'div', 'x-creator-list');
    const visible = visibleCreatorPosts();
    if (!visible.length) {
      list.classList.add('is-empty');
      const empty = node(list, 'div', 'x-empty-card');
      empty.setAttribute('role', 'status');
      creatorEmptyIcon(empty);
      node(empty, 'strong', '', t(categoryPosts().length ? 'batchNoMatch' : 'creatorEmptyTitle'));
      node(empty, 'p', '', t(categoryPosts().length ? 'batchAdjustFilters' : 'creatorEmptyDetail'));
    }
    visible.forEach((post) => {
      const row = node(list, 'article', 'x-creator-item');
      const check = node(row, 'input', 'x-checkbox');
      check.type = 'checkbox';
      const id = post.shortcode || post.id;
      check.checked = selectedPosts.has(id);
      check.addEventListener('change', () => {
        if (check.checked) selectedPosts.add(id);
        else selectedPosts.delete(id);
        const count = creatorBody.querySelector('.x-creator-selection-count');
        if (count) count.textContent = t('selectedCount', { count: selectedPosts.size });
        const addButton = creatorBody.querySelector('.x-creator-selection .x-dl-btn');
        if (addButton) addButton.disabled = !selectedPosts.size;
      });
      const slot = node(row, 'div', 'x-creator-cover-slot' + creatorCoverClass(post));
      const media = post.media?.[0];
      const placeholder = node(slot, 'div', 'x-creator-cover x-creator-cover-ph');
      if (media && previewUrls(media).length) {
        const thumb = node(slot, 'img', 'x-creator-cover');
        thumb.alt = '';
        thumb.loading = 'lazy';
        placeholder.classList.add('hidden');
        setMediaPreview(thumb, media, () => {
          thumb.remove();
          placeholder.classList.remove('hidden');
        });
      }
      const body = node(row, 'div', 'x-creator-item-body');
      const link = node(body, 'a', 'x-creator-item-title', post.title || id);
      link.href = Model.permalinkUrl(post);
      link.target = '_blank';
      node(body, 'div', 'x-creator-item-meta', [
        post.pinned ? t('pinnedPost') : '',
        post.quotedMediaOnly ? t('quotedMediaBadge') : '',
        pageTypeLabel(post),
        post.media?.length ? t('mediaCount', { count: post.media.length }) : '',
        formatPostDate(post.publishTime)
      ].filter(Boolean).join(' · '));
      if (creatorItems(post).length && creatorItems(post).every(media => savedMediaKeys.has(downloadKey(post, media)))) node(body, 'span', 'x-batch-saved', t('batchSaved'));
      if (!creatorReady(post)) node(body, 'span', 'x-creator-resource-status', t('creatorNeedsResolve'));
    });
    if (filteredCreatorPosts().length > creatorVisibleLimit) button(creatorBody, t('creatorLoadMore'), 'x-mini-button x-creator-load-more', () => {
      creatorVisibleLimit += 60;
      renderCreator();
    });
    const selection = node(creatorBody, 'div', 'x-creator-selection');
    node(selection, 'p', 'x-creator-selection-count', t('selectedCount', { count: selectedPosts.size }));
    const add = button(selection, t('addToQueue'), 'x-dl-btn', () => enqueueSelectedCreator().catch((error) => setStatus(error.message, 'error')));
    add.disabled = !selectedPosts.size;
    list.scrollTop = scrollTop;
  }

  function requestResolve(posts) {
    resolveEpoch += 1;
    window.postMessage({ source: CONTENT_SOURCE, type: 'RESOLVE_POSTS', epoch: resolveEpoch, posts }, location.origin);
    return resolveEpoch;
  }

  function waitForResolve(epoch, expectedCount) {
    return new Promise((resolve) => {
      const resolved = new Set();
      let received = 0;
      const timer = setTimeout(done, 30000);
      function done() { clearTimeout(timer); window.removeEventListener('message', onMessage); resolve(resolved); }
      function onMessage(event) {
        if (event.source !== window || event.origin !== location.origin || event.data?.source !== SOURCE || event.data?.epoch !== epoch) return;
        if (event.data.type === 'RESOLVE_RESULT') {
          received += 1;
          if (event.data.post?.shortcode) resolved.add(event.data.post.shortcode);
          if (received >= expectedCount) done();
        }
      }
      window.addEventListener('message', onMessage);
    });
  }

  async function enqueueSelectedCreator() {
    const selected = filteredCreatorPosts().filter((post) => selectedPosts.has(post.shortcode || post.id));
    if (!selected.length) {
      setStatus(t('noSelectedVideos'), 'warn');
      return;
    }
    const tasks = [];
    for (const chosen of selected) {
      const post = creatorPosts.get(chosen.shortcode || chosen.id) || chosen;
      const items = creatorItems(post);
      if (!items.length || !items.every(media => pickResource(media)?.url)) continue;
      const result = await enqueueMedia(post, items, { queue: 'creator' });
      if (result.added || result.duplicateCount) tasks.push(post);
    }
    if (tasks.length < selected.length) setStatus(t('creatorResolvePartial', { count: selected.length - tasks.length }), 'warn');
  }

  const FILENAME_PRESETS = {
    'title-author': '{title} - {author}',
    'author-title': '{author} - {title}',
    title: '{title}',
    'title-id': '{title} - {id}',
    detailed: '{title} - {author} - {quality}'
  };
  const FILENAME_CHIPS = [
    ['title', 'chipTitle'],
    ['author', 'chipAuthor'],
    ['id', 'chipId'],
    ['index', 'chipIndex'],
    ['quality', 'chipQuality'],
    ['date', 'chipDate']
  ];

  function themeChoices() {
    const listed = shell.theme?.list?.() || [{ id: 'default', name: t('themeFacebook') }];
    return listed.map((item) => ({
      id: item.id,
      name: item.id === 'default' ? t('themeFacebook') : (DownloaderKit.i18n?.t?.('theme-' + item.id) === 'theme-' + item.id ? item.name : t('theme-' + item.id))
    }));
  }

  function syncThemePicker(themeControl) {
    if (!themeControl) return;
    const currentId = shell.theme?.current?.() || 'default';
    const current = themeChoices().find((item) => item.id === currentId) || themeChoices()[0];
    const currentLabel = themeControl.querySelector('.x-dl-settings-theme-current-label');
    const currentSwatch = themeControl.querySelector('.x-dl-settings-theme-current-swatch');
    if (currentLabel) currentLabel.textContent = current?.name || t('themeFacebook');
    if (currentSwatch) currentSwatch.dataset.theme = currentId === 'default' ? 'facebook' : currentId;
    themeControl.querySelectorAll('[data-theme-option]').forEach((option) => {
      option.setAttribute('aria-selected', String(option.dataset.themeOption === currentId));
    });
  }

  function fillSettingsSheet(body) {
    settingsBody = body;
    body.replaceChildren();
    const root = document.createElement('div');
    root.className = 'x-dl-settings';

    const themeRow = document.createElement('div');
    themeRow.className = 'x-dl-settings-row';
    const themeRowLabel = document.createElement('span');
    themeRowLabel.textContent = t('theme');
    const themeControl = document.createElement('div');
    themeControl.className = 'x-dl-settings-theme-control';
    const themeTrigger = document.createElement('button');
    themeTrigger.type = 'button';
    themeTrigger.className = 'x-dl-settings-theme-trigger';
    themeTrigger.setAttribute('aria-label', t('theme'));
    themeTrigger.setAttribute('aria-haspopup', 'listbox');
    themeTrigger.setAttribute('aria-expanded', 'false');
    const currentSwatch = document.createElement('span');
    currentSwatch.className = 'x-dl-settings-theme-swatch x-dl-settings-theme-current-swatch';
    currentSwatch.setAttribute('aria-hidden', 'true');
    const currentLabel = document.createElement('span');
    currentLabel.className = 'x-dl-settings-theme-current-label';
    const chevron = document.createElement('span');
    chevron.className = 'x-dl-settings-theme-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    themeTrigger.append(currentSwatch, currentLabel, chevron);
    const themeOptions = document.createElement('div');
    themeOptions.className = 'x-dl-settings-theme-options hidden';
    themeOptions.setAttribute('role', 'listbox');
    function renderThemeOptions() {
      themeOptions.replaceChildren();
      themeChoices().forEach((theme) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'x-dl-settings-theme-option';
        option.dataset.themeOption = theme.id;
        option.setAttribute('role', 'option');
        const swatch = document.createElement('span');
        swatch.className = 'x-dl-settings-theme-swatch';
        swatch.dataset.theme = theme.id === 'default' ? 'facebook' : theme.id;
        swatch.setAttribute('aria-hidden', 'true');
        const optionLabel = document.createElement('span');
        optionLabel.textContent = theme.name;
        option.append(swatch, optionLabel);
        option.addEventListener('click', async () => {
          setThemeMenuOpen(false);
          try {
            await shell.theme.set(theme.id);
            syncThemePicker(themeControl);
            status.textContent = t('themeSaved');
          } catch (error) {
            status.textContent = error?.message || t('themeSaveFailed');
          }
        });
        themeOptions.appendChild(option);
      });
      syncThemePicker(themeControl);
    }
    function setThemeMenuOpen(open) {
      themeOptions.classList.toggle('hidden', !open);
      themeTrigger.setAttribute('aria-expanded', String(open));
      themeControl.classList.toggle('is-open', open);
    }
    renderThemeOptions();
    themeTrigger.addEventListener('click', () => {
      setThemeMenuOpen(themeOptions.classList.contains('hidden'));
    });
    themeControl.append(themeTrigger, themeOptions);
    themeRow.append(themeRowLabel, themeControl);
    root.appendChild(themeRow);

    const languageRow = document.createElement('div');
    languageRow.className = 'x-dl-settings-row';
    const languageLabel = document.createElement('span');
    languageLabel.textContent = t('language');
    const languageControl = document.createElement('div');
    languageControl.className = 'x-dl-settings-control';
    const languageWrap = document.createElement('div');
    languageWrap.className = 'x-dl-settings-select-wrap';
    const languageSelect = document.createElement('select');
    languageSelect.className = 'x-dl-settings-select';
    languageSelect.setAttribute('aria-label', t('language'));
    [
      ['en', t('english')],
      ['zh-CN', t('chinese')]
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      languageSelect.appendChild(option);
    });
    languageSelect.value = DownloaderKit.i18n?.language?.() || 'en';
    languageSelect.addEventListener('mousedown', () => setThemeMenuOpen(false));
    languageSelect.addEventListener('change', () => {
      const value = languageSelect.value === 'en' ? 'en' : 'zh-CN';
      DownloaderKit.i18n.save(value).then(() => applyLanguage()).catch(() => {});
    });
    languageWrap.appendChild(languageSelect);
    languageControl.appendChild(languageWrap);
    languageRow.append(languageLabel, languageControl);
    root.appendChild(languageRow);

    const presetRow = document.createElement('div');
    presetRow.className = 'x-dl-settings-row';
    const presetLabel = document.createElement('span');
    presetLabel.textContent = t('filename');
    const filenameControl = document.createElement('div');
    filenameControl.className = 'x-dl-settings-control';
    const presetWrap = document.createElement('div');
    presetWrap.className = 'x-dl-settings-select-wrap';
    const preset = document.createElement('select');
    preset.className = 'x-dl-settings-select';
    preset.setAttribute('aria-label', t('filenameRule'));
    preset.addEventListener('mousedown', () => setThemeMenuOpen(false));
    [
      ['title-author', t('presetDefault')],
      ['author-title', t('presetAuthorTitle')],
      ['title', t('presetTitle')],
      ['title-id', t('presetTitleId')],
      ['detailed', t('presetDetailed')],
      ['custom', t('presetCustom')]
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      preset.appendChild(option);
    });
    presetWrap.appendChild(preset);
    filenameControl.appendChild(presetWrap);
    presetRow.append(presetLabel, filenameControl);
    root.appendChild(presetRow);

    const customBlock = document.createElement('div');
    customBlock.className = 'x-dl-settings-custom';
    customBlock.hidden = true;
    const template = document.createElement('input');
    template.type = 'text';
    template.className = 'x-dl-settings-input';
    template.maxLength = 180;
    template.spellcheck = false;
    template.autocomplete = 'off';
    template.placeholder = '{title} - {author}';
    template.setAttribute('aria-label', t('customTemplate'));
    customBlock.appendChild(template);
    const chips = document.createElement('div');
    chips.className = 'x-dl-settings-chips';
    FILENAME_CHIPS.forEach(([key, label]) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'x-dl-settings-chip';
      chip.textContent = t(label);
      chip.title = '{' + key + '}';
      chip.addEventListener('click', () => {
        const start = template.selectionStart ?? template.value.length;
        const end = template.selectionEnd ?? start;
        const token = '{' + key + '}';
        template.value = template.value.slice(0, start) + token + template.value.slice(end);
        const pos = start + token.length;
        template.focus();
        template.setSelectionRange(pos, pos);
        syncPresetFromTemplate();
        refreshPreview();
        queueSave();
      });
      chips.appendChild(chip);
    });
    customBlock.appendChild(chips);
    root.appendChild(customBlock);

    const preview = document.createElement('p');
    preview.className = 'x-dl-settings-preview';
    const error = document.createElement('p');
    error.className = 'x-dl-settings-error';
    error.hidden = true;
    root.append(preview, error);
    const foot = document.createElement('div');
    foot.className = 'x-dl-settings-foot';
    const status = document.createElement('span');
    status.className = 'x-dl-settings-status';
    status.setAttribute('role', 'status');
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'x-dl-settings-reset';
    reset.textContent = t('resetDefault');
    foot.append(status, reset);
    root.appendChild(foot);
    const adSetting = node(root, 'label', 'x-dl-ad-setting');
    const adToggle = node(adSetting, 'input', '');
    adToggle.type = 'checkbox';
    adToggle.checked = prefs.hideAds === true;
    node(adSetting, 'span', '', t('hideAds'));
    node(root, 'p', 'x-muted', t('hideAdsHint'));
    adToggle.addEventListener('change', async () => {
      try {
        await savePrefs({ hideAds: adToggle.checked });
        addFeedEntries();
      } catch (error) { setStatus(error.message, 'error'); }
    });
    body.appendChild(root);
    syncThemePicker(themeControl);

    let saveTimer = 0;
    function matchPreset(value) {
      const text = String(value || '').trim();
      for (const [key, tpl] of Object.entries(FILENAME_PRESETS)) {
        if (tpl === text) return key;
      }
      return 'custom';
    }
    function syncCustomVisibility() {
      customBlock.hidden = preset.value !== 'custom';
    }
    function syncPresetFromTemplate() {
      preset.value = matchPreset(template.value.trim());
      syncCustomVisibility();
    }
    function currentTemplate() {
      if (preset.value !== 'custom' && FILENAME_PRESETS[preset.value]) return FILENAME_PRESETS[preset.value];
      return template.value.trim();
    }
    function refreshPreview() {
      try {
        const name = DownloaderKit.settings.filename(currentTemplate(), {
          title: t('sampleTitle'),
          author: t('sampleAuthor'),
          id: 'CxyzSample01',
          index: 2,
          quality: '1440x1800'
        }, 'jpg');
        error.hidden = true;
        error.textContent = '';
        preview.textContent = t('preview', { name });
        return currentTemplate();
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message || t('invalidTemplate');
        preview.textContent = t('previewEmpty');
        return false;
      }
    }
    function applyForm(settings) {
      template.value = settings?.filenameTemplate || DEFAULT_PREFS.filenameTemplate;
      preset.value = matchPreset(template.value);
      syncCustomVisibility();
      refreshPreview();
    }
    async function persist(showOk) {
      const nextTemplate = refreshPreview();
      if (!nextTemplate) {
        status.textContent = t('invalidTemplate');
        return;
      }
      try {
        await shell.settings.save(nextTemplate);
        if (activeMode === 'current') renderCurrent();
        status.textContent = showOk ? t('saved') : '';
      } catch (err) {
        status.textContent = err?.message || t('themeSaveFailed');
      }
    }
    function queueSave() {
      status.textContent = '';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { persist(true); }, 280);
    }
    preset.addEventListener('change', () => {
      if (preset.value !== 'custom' && FILENAME_PRESETS[preset.value]) template.value = FILENAME_PRESETS[preset.value];
      syncCustomVisibility();
      refreshPreview();
      queueSave();
    });
    template.addEventListener('input', () => {
      syncPresetFromTemplate();
      refreshPreview();
      queueSave();
    });
    reset.addEventListener('click', async () => {
      clearTimeout(saveTimer);
      try {
        const saved = await shell.settings.save(DEFAULT_PREFS.filenameTemplate);
        applyForm(saved);
        if (activeMode === 'current') renderCurrent();
        status.textContent = t('restored');
      } catch (err) {
        status.textContent = err?.message || t('restoreFailed');
      }
    });
    shell.settings?.ready?.then(() => applyForm(shell.settings.current())).catch((err) => {
      status.textContent = err?.message || t('loadFailed');
    });
    shell.theme?.ready?.then(() => renderThemeOptions()).catch(() => {});
  }

  function applyLanguage() {
    const root = document.getElementById('facebook-dl-root');
    DownloaderKit.i18n.apply(root || ui);
    syncFloatingEntry();
    renderView();
    if (settingsBody?.isConnected) {
      const pageTitle = document.getElementById('facebook-dl-info-title');
      const pageDate = document.getElementById('facebook-dl-info-date');
      if (pageTitle) pageTitle.textContent = t('settings');
      if (pageDate) {
        pageDate.textContent = t('settingsHint');
        pageDate.hidden = false;
      }
      fillSettingsSheet(settingsBody);
    }
  }

  document.addEventListener('pointerdown', (event) => {
    const themeControl = document.querySelector('.x-dl-settings-theme-control');
    if (!themeControl || themeControl.contains(event.target)) return;
    themeControl.querySelector('.x-dl-settings-theme-options')?.classList.add('hidden');
    themeControl.querySelector('.x-dl-settings-theme-trigger')?.setAttribute('aria-expanded', 'false');
    themeControl.classList.remove('is-open');
  });

  async function savePrefs(patch) {
    prefs = { ...prefs, ...patch };
    await DownloaderKit.runtime.storageSet({ [PREFS_KEY]: prefs }, EXT);
    syncFloatingEntry();
    updateAdVisibility();
  }

  async function loadPrefs() {
    const stored = await DownloaderKit.runtime.storageGet([PREFS_KEY], EXT);
    if (stored?.[PREFS_KEY] && typeof stored[PREFS_KEY] === 'object') prefs = { ...DEFAULT_PREFS, ...stored[PREFS_KEY] };
    updateAdVisibility();
  }

  function renderView() {
    syncFloatingEntry();
    addFeedEntries();
    if (!shell.panel?.isOpen?.()) { publishPopupInfo(); return; }
    syncTabs();
    if (activeMode === 'creator') renderCreator();
    else renderCurrent();
    refreshJobPanel().catch(() => {});
    publishPopupInfo();
    scheduleFeedPosition();
  }

  function popupInfo() {
    const post = currentPost();
    if (!post) {
      if (snapshot.kind === 'profile') {
        return {
          mode: 'creator',
          title: snapshot.creator?.displayName || snapshot.creator?.username || t('creator'),
          author: snapshot.creator?.username || '',
          cover: snapshot.creator?.avatar || '',
          sub: t('profileBatch'),
          mediaCount: creatorPosts.size
        };
      }
      return null;
    }
    return {
      mode: pageType(post),
      title: post.title || t('facebookPost'),
      author: post.author?.username || '',
      cover: coverUrl(post, post.media?.[0]),
      sub: [pageTypeLabel(post), t('mediaCount', { count: post.media?.length || 0 })].join(' · '),
      mediaCount: post.media?.length || 0,
      qualities: (() => {
        const resource = pickResource(post.media?.[0]);
        return resource?.width ? [resource.width + 'x' + resource.height] : [];
      })()
    };
  }

  function publishPopupInfo() {
    if (window !== window.top) return;
    const info = popupInfo();
    const root = document.getElementById('facebook-dl-root');
    if (root) {
      if (info) root.setAttribute('data-popup-info', JSON.stringify(info));
      else root.removeAttribute('data-popup-info');
    }
    if (!info) return;
    DownloaderKit.runtime.storageSet({ 'facebook-dl-popup-info-v1': { at: Date.now(), tabUrl: location.href, info } }, EXT).catch(() => {});
    EXT.runtime.sendMessage({ type: 'FACEBOOK_DL_PAGE_INFO', url: location.href, info }, () => { void EXT.runtime.lastError; });
  }

  let snapshotReadToken = 0;
  async function onSnapshot(payload) {
    if (!payload || (payload.url && payload.url !== location.href)) return;
    const readToken = ++snapshotReadToken;
    const readUrl = location.href;
    const detailRoute = Model.routeFromUrl(readUrl);
    if (['post'].includes(detailRoute.kind) && detailRoute.shortcode) {
      let cached = resourceCache.get(detailRoute.shortcode);
      if (!creatorReady(cached || {})) {
        const result = await readResourceCache([detailRoute.shortcode]);
        cached = result?.posts?.find((post) => post.shortcode === detailRoute.shortcode);
      }
      if (readToken !== snapshotReadToken || readUrl !== location.href) return;
      if (creatorReady(cached || {})) {
        resourceCache.set(detailRoute.shortcode, cached);
        payload = { ...payload, post: cached };
      }
    }
    const previousKind = snapshot.kind;
    snapshot = payload;
    syncFloatingEntry();
    const currentRoute = Model.routeFromUrl(location.href);
    if (currentRoute.kind === 'post' && currentRoute.shortcode &&
        !payload.post?.media?.some((item) => pickResource(item)?.url) &&
        !detailResolveAttempted.has(currentRoute.shortcode)) {
      detailResolveAttempted.add(currentRoute.shortcode);
      requestResolve([{
        pageUrl: Model.permalinkUrl({ shortcode: currentRoute.shortcode, author: { username: currentRoute.username } }),
        shortcode: currentRoute.shortcode,
        kind: 'post'
      }]);
    }
    if (payload.kind === 'profile') {
      const key = currentRoute.username || payload.creator?.username || location.pathname;
      if (key.toLowerCase() !== creatorKey) {
        creatorKey = key.toLowerCase();
        selectedPosts = new Set();
        creatorVisibleLimit = 60;
        if (!creatorCaches.has(creatorKey)) creatorCaches.set(creatorKey, new Map());
        creatorPosts = creatorCaches.get(creatorKey);
        while (creatorCaches.size > 5) {
          const oldest = creatorCaches.keys().next().value;
          creatorCaches.delete(oldest);
          for (const category of creatorCategories.keys()) if (category.startsWith(oldest + ':')) creatorCategories.delete(category);
          for (const attempt of creatorAutoAttempts.keys()) if (attempt.startsWith(oldest + ':')) creatorAutoAttempts.delete(attempt);
        }
      }
      refreshProfileCreatorData(payload);
      scheduleProfileDomScan();
    }
    if (payload.post) {
      const owner = payload.post.author?.username?.toLowerCase();
      cacheResolved(payload.post, creatorCaches.get(owner) || new Map());
    }
    const routeChanged = previousKind !== payload.kind || route !== location.href;
    if (routeChanged) {
      threadScanToken += 1;
      threadScanning = false;
      creatorScanToken += 1;
      creatorScanning = false;
      viewedPost = null;
      viewedPostArticle = null;
      viewedPostLoading = false;
      viewedPostToken += 1;
      creatorPrepareToken += 1;
      creatorPreparing = false;
      window.postMessage({ source: CONTENT_SOURCE, type: 'CANCEL_RESOLVE' }, location.origin);
      setStatus('', 'info');
      selectedPosts = new Set();
      creatorVisibleLimit = 60;
      if (payload.kind === 'profile') {
        const expectedUrl = location.href;
        setTimeout(() => {
          if (location.href === expectedUrl && snapshot.kind === 'profile') {
            refreshProfileCreatorData();
            renderCreator();
          }
        }, 600);
      }
      route = location.href;
      selectedMedia = new Set();
      mediaSelectionPost = '';
      if (payload.kind === 'profile') activeMode = 'creator';
      else activeMode = 'current';
    }
    renderView();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.source === SOURCE && event.data?.type === 'SNAPSHOT') onSnapshot(event.data.payload).catch(() => {});
    if (event.data?.source === SOURCE && event.data?.type === 'RESOLVE_RESULT' && event.data.post) {
      const currentProfile = snapshot.kind === 'profile' &&
        event.data.post.author?.username?.toLowerCase() === String(creatorKey).toLowerCase();
      if (currentProfile && creatorPosts.has(event.data.post.shortcode)) cacheResolved(event.data.post);
      if (viewedPost?.shortcode === event.data.post.shortcode) {
        viewedPost = viewedPostArticle ? mergeFeedAuthors(event.data.post, viewedPostArticle) : event.data.post;
        cacheResolved(viewedPost);
      }
      const currentRoute = Model.routeFromUrl(location.href);
      if (currentRoute.shortcode === event.data.post.shortcode) snapshot.post = event.data.post;
      if (currentProfile || viewedPost?.shortcode === event.data.post.shortcode || snapshot.post?.shortcode === event.data.post.shortcode) renderView();
    }
  });
  window.addEventListener('popstate', () => {
    window.postMessage({ source: CONTENT_SOURCE, type: 'GET_SNAPSHOT' }, location.origin);
  });

  EXT.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'FACEBOOK_DL_GET_POST') {
      const shortcode = String(message.shortcode || '');
      respond({ ok: true, post: snapshot.post?.shortcode === shortcode ? snapshot.post : null });
      return undefined;
    }
    if (message?.type === 'FACEBOOK_DL_GET_INFO') {
      if (window !== window.top) return undefined;
      respond({ ok: true, data: { info: popupInfo() || { title: t('waitPost'), sub: t('waitPostDetail') } } });
      return undefined;
    }
    if (message?.type === 'FACEBOOK_DL_OPEN_PANEL') {
      if (!openProfileBatch()) {
        shell.open?.();
        renderView();
      }
      respond({ ok: true });
      return undefined;
    }
    if (message?.type === 'FACEBOOK_DL_TASKS_CHANGED') {
      scheduleDownloadStateRefresh(message.kind);
      return undefined;
    }
    return undefined;
  });

  let downloadStateTimer = 0;
  let pendingSavedRefresh = false;
  function scheduleDownloadStateRefresh(kind) {
    pendingSavedRefresh ||= kind !== 'progress';
    if (downloadStateTimer && kind === 'progress') return;
    clearTimeout(downloadStateTimer);
    downloadStateTimer = setTimeout(async () => {
      downloadStateTimer = 0;
      const refreshMarks = pendingSavedRefresh;
      pendingSavedRefresh = false;
      if (refreshMarks) {
        await refreshSavedMarks().catch(() => {});
        renderView();
      } else refreshJobPanel().catch(() => {});
    }, pendingSavedRefresh ? 100 : 900);
  }

  // Background runtime broadcasts do not reach content scripts. Observe the
  // persisted queue and completion index directly, including other X tabs.
  function onDownloadStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes['facebook-dl-completed-keys-v1'] || changes['facebook-dl-history-v1']) {
      scheduleDownloadStateRefresh('terminal');
    } else if (changes['facebook-dl-tasks-v1']) {
      const change = changes['facebook-dl-tasks-v1'];
      const previous = new Map((change.oldValue || []).map(task => [task.id, task.status]));
      const statusChanged = (change.newValue || []).some(task => previous.get(task.id) !== task.status)
        || (change.oldValue || []).length !== (change.newValue || []).length;
      scheduleDownloadStateRefresh(statusChanged ? 'tasks' : 'progress');
    }
  }
  EXT.storage.onChanged.addListener(onDownloadStorageChanged);

  DownloaderKit.i18n?.ready?.then(() => {
    applyLanguage();
  }).catch(() => {});
  refreshSavedMarks().catch(() => {});
  loadPrefs().then(() => {
    syncFloatingEntry();
  }).catch(() => {});
  shell.settings?.ready?.then(() => {
    const current = shell.settings.current();
    const template = String(current?.filenameTemplate || '').trim();
    if (!template || template === '{author} - {title}') {
      shell.settings.save(DEFAULT_PREFS.filenameTemplate).catch(() => {});
    }
  });
  window.postMessage({ source: CONTENT_SOURCE, type: 'GET_SNAPSHOT' }, location.origin);

  const fabPanel = document.getElementById('facebook-dl-panel');
  const toggleBtn = document.getElementById('facebook-dl-toggle');
  if (fabPanel && toggleBtn) {
    let toggleDragged = false;
    let dragActive = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragPanelLeft = 0;
    let dragPanelTop = 0;
    let dragMoved = false;
    let dragPointerId = null;
    const FAB_SIZE = 64;
    const FAB_MARGIN = 8;
    const FAB_POS_KEY = 'facebook-dl-fab-pos-v1';

    function clampFabPos(left, top) {
      const maxL = Math.max(FAB_MARGIN, window.innerWidth - FAB_SIZE - FAB_MARGIN);
      const maxT = Math.max(FAB_MARGIN, window.innerHeight - FAB_SIZE - FAB_MARGIN);
      return {
        left: Math.min(Math.max(left, FAB_MARGIN), maxL),
        top: Math.min(Math.max(top, FAB_MARGIN), maxT)
      };
    }

    function applyFabPos(left, top) {
      const pos = clampFabPos(left, top);
      fabPanel.style.left = pos.left + 'px';
      fabPanel.style.top = pos.top + 'px';
      fabPanel.style.right = 'auto';
      fabPanel.style.bottom = 'auto';
      return pos;
    }

    function onFabPointerMove(event) {
      if (!dragActive || event.pointerId !== dragPointerId) return;
      const dx = event.clientX - dragStartX;
      const dy = event.clientY - dragStartY;
      if (!dragMoved && Math.abs(dx) + Math.abs(dy) > 6) {
        dragMoved = true;
        toggleDragged = true;
        toggleBtn.classList.add('dragging');
      }
      if (dragMoved) {
        event.preventDefault();
        applyFabPos(dragPanelLeft + dx, dragPanelTop + dy);
      }
    }

    function onFabPointerUp(event) {
      if (!dragActive || event.pointerId !== dragPointerId) return;
      dragActive = false;
      dragPointerId = null;
      document.removeEventListener('pointermove', onFabPointerMove, true);
      document.removeEventListener('pointerup', onFabPointerUp, true);
      document.removeEventListener('pointercancel', onFabPointerUp, true);
      toggleBtn.classList.remove('dragging');
      fabPanel.style.transition = '';
      if (dragMoved) {
        const rect = fabPanel.getBoundingClientRect();
        const pos = applyFabPos(rect.left, rect.top);
        DownloaderKit.runtime.storageSet({ [FAB_POS_KEY]: pos }, EXT).catch(() => {});
      }
      setTimeout(() => { toggleDragged = false; }, 120);
    }

    let suppressToggleClick = false;
    function openFloatingPanel() {
      if (shell.panel?.isOpen?.()) {
        shell.panel.hide();
        return true;
      }
      const kind = Model.routeFromUrl(location.href).kind;
      if (kind === 'profile') return openProfileBatch();
      if (kind !== 'post') return false;
      viewedPostArticle = null;
      const menu = document.getElementById('facebook-dl-menu');
      menu?.classList.remove('is-following');
      ['left', 'top', 'right', 'bottom', 'max-height', 'height', 'min-height', 'position'].forEach((prop) => menu?.style.removeProperty(prop));
      shell.showHome?.();
      shell.open?.();
      renderView();
      window.postMessage({ source: CONTENT_SOURCE, type: 'GET_SNAPSHOT' }, location.origin);
      return true;
    }
    toggleBtn.addEventListener('pointerup', (event) => {
      if (dragMoved || toggleDragged) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (!openFloatingPanel()) return;
      suppressToggleClick = true;
      event.preventDefault();
      event.stopPropagation();
    });
    toggleBtn.addEventListener('click', (event) => {
      if (toggleDragged || suppressToggleClick) {
        suppressToggleClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (openFloatingPanel()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    toggleBtn.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      dragActive = true;
      dragMoved = false;
      toggleDragged = false;
      dragPointerId = event.pointerId;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      const rect = fabPanel.getBoundingClientRect();
      dragPanelLeft = rect.right - FAB_SIZE;
      dragPanelTop = rect.bottom - FAB_SIZE;
      if (fabPanel.style.left && fabPanel.style.left !== 'auto') {
        dragPanelLeft = parseFloat(fabPanel.style.left) || dragPanelLeft;
        dragPanelTop = parseFloat(fabPanel.style.top) || dragPanelTop;
      }
      fabPanel.style.transition = 'none';
      applyFabPos(dragPanelLeft, dragPanelTop);
      document.addEventListener('pointermove', onFabPointerMove, true);
      document.addEventListener('pointerup', onFabPointerUp, true);
      document.addEventListener('pointercancel', onFabPointerUp, true);
    });
    toggleBtn.addEventListener('dragstart', (event) => event.preventDefault());

    DownloaderKit.runtime.storageGet([FAB_POS_KEY], EXT).then((data) => {
      const pos = data?.[FAB_POS_KEY];
      if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) applyFabPos(pos.left, pos.top);
    }).catch(() => {});

    let fabResizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(fabResizeTimer);
      fabResizeTimer = setTimeout(() => {
        const left = parseFloat(fabPanel.style.left);
        const top = parseFloat(fabPanel.style.top);
        if (!Number.isFinite(left) || !Number.isFinite(top)) return;
        const pos = applyFabPos(left, top);
        DownloaderKit.runtime.storageSet({ [FAB_POS_KEY]: pos }, EXT).catch(() => {});
      }, 100);
    });
  }
})();
