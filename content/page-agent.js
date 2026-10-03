/**
 * Facebook Downloader -- page data reader (MAIN world).
 * Reads public page state and Facebook network responses.
 * Does not change page behavior except optional sponsored-edge filtering.
 */
(function bootFacebookPageAgent() {
  'use strict';
  if (window.__FACEBOOK_DOWNLOADER_PAGE_AGENT__) return;
  window.__FACEBOOK_DOWNLOADER_PAGE_AGENT__ = true;
  window.__FACEBOOK_DOWNLOADER_PAGE_AGENT_VERSION__ = 1;

  const Model = window.FacebookDownloaderModel;
  if (!Model) return;

  const SOURCE = 'facebook-downloader-page-agent';
  const CONTENT_SOURCE = 'facebook-downloader-content';
  const collected = { posts: new Map(), stories: [], creators: [], seen: new WeakSet(), consumed: new Set(), count: 0 };
  const profileCaptures = new Map();
  const scannedScripts = new WeakSet();
  let initialHtmlScanned = false;
  const detailCache = new Map();
  const detailFailures = new Map();
  const resolveQueue = [];
  const resolveControllers = new Set();
  let resolveActive = 0;
  let resolveEpoch = 0;
  let hideFeedAds = false;
  let lastSnapshotJson = '';
  let lastUrl = location.href;
  let scheduled = 0;

  function profileCaptureKey() {
    const url = new URL(location.href);
    const path = url.pathname.toLowerCase().replace(/\/$/, '');
    const sk = (url.searchParams.get('sk') || '').toLowerCase();
    return sk ? path + '?sk=' + sk : path;
  }

  function ingest(data, extra) {
    if (!data) return;
    const route = Model.routeFromUrl(location.href);
    if (route.kind === 'profile') {
      const bag = { posts: new Map(), stories: [], creators: [], seen: new WeakSet(), consumed: new Set(), count: 0 };
      Model.collectFromJson(data, bag, extra || {});
      const key = profileCaptureKey();
      if (!profileCaptures.has(key)) profileCaptures.set(key, new Set());
      for (const post of bag.posts.values()) {
        const author = post.author?.username?.toLowerCase() || '';
        if (!route.username || !author || author === route.username.toLowerCase()) profileCaptures.get(key).add(post.id);
      }
      const ids = profileCaptures.get(key);
      while (ids.size > 1000) ids.delete(ids.values().next().value);
      while (profileCaptures.size > 5) profileCaptures.delete(profileCaptures.keys().next().value);
    }
    Model.collectFromJson(data, collected, extra || {});
    while (collected.posts.size > 1000) collected.posts.delete(collected.posts.keys().next().value);
  }

  function parsePayloadText(value) {
    let raw = String(value || '').trim();
    if (!raw) return [];
    if (raw.startsWith('for (;;);')) raw = raw.slice('for (;;);'.length).trim();
    const payloads = [];
    try {
      payloads.push(JSON.parse(raw));
      return payloads;
    } catch (_) {}
    raw.split(/\n+/).forEach((line) => {
      const piece = line.trim().replace(/^for \(;;\);/, '');
      if (!piece || (piece[0] !== '{' && piece[0] !== '[')) return;
      try { payloads.push(JSON.parse(piece)); } catch (_) {}
    });
    return payloads;
  }

  function parseMaybeJson(value) {
    if (!value) return;
    if (typeof value === 'object') {
      ingest(value);
      return;
    }
    parsePayloadText(value).forEach((payload) => ingest(payload));
  }

  function scanScripts() {
    const scripts = document.querySelectorAll('script');
    for (const node of scripts) {
      if (scannedScripts.has(node)) continue;
      scannedScripts.add(node);
      const type = String(node.type || '').toLowerCase();
      if (type === 'application/json' || node.id === '__NEXT_DATA__') parseMaybeJson(node.textContent);
    }
    if (!initialHtmlScanned && document.readyState !== 'loading') {
      initialHtmlScanned = true;
      Model.parseHtmlPayloads(document.documentElement?.innerHTML || '').forEach((payload) => ingest(payload));
    }
  }

  function visibleArticle() {
    const articles = [...document.querySelectorAll('[role="article"]')];
    let best = null;
    let bestScore = -1;
    articles.forEach((node) => {
      if (node.closest('#facebook-dl-root')) return;
      const rect = node.getBoundingClientRect();
      if (rect.height < 80 || rect.bottom < 80 || rect.top > window.innerHeight - 40) return;
      const score = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    });
    return best;
  }

  function candidatesFromImage(image, source) {
    if (!image) return [];
    const list = [];
    const push = (url, extra) => {
      const href = Model.allowedMediaUrl(url);
      if (!href || Model.looksLikeAvatar(href) || Model.STATIC_HINT.test(href)) return;
      list.push({
        url: href,
        mime: 'image/jpeg',
        width: Number(extra?.width) || image.naturalWidth || 0,
        height: Number(extra?.height) || image.naturalHeight || 0,
        bitrate: 0,
        sizeBytes: 0,
        source: source || 'dom',
        backupUrls: []
      });
    };
    push(image.currentSrc || image.src, {});
    String(image.srcset || '').split(',').forEach((part) => {
      const bits = part.trim().split(/\s+/);
      push(bits[0], { width: parseInt(bits[1], 10) || 0 });
      if (list.length) list[list.length - 1].source = 'srcset';
    });
    return list;
  }

  function domPost(route) {
    const article = visibleArticle();
    const root = article || document;
    if (!article && route.kind === 'feed') return null;
    const link = [...root.querySelectorAll('a[href]')].find((item) => Model.routeFromUrl(item.href).kind === 'post');
    const shortcode = route.shortcode || Model.shortcodeOf(link?.href || location.href);
    if (!shortcode) return null;
    const images = [...root.querySelectorAll('img')].filter((image) => {
      if (image.closest('#facebook-dl-root')) return false;
      const href = Model.httpsUrl(image.currentSrc || image.src);
      if (!href || Model.looksLikeAvatar(href) || Model.STATIC_HINT.test(href)) return false;
      const width = image.naturalWidth || image.clientWidth || 0;
      const height = image.naturalHeight || image.clientHeight || 0;
      return !width || !height || width >= 120 || height >= 120;
    });
    const videos = [...root.querySelectorAll('video')].filter((video) => !video.closest('#facebook-dl-root'));
    const imageCandidates = images.flatMap((image) => candidatesFromImage(image, 'dom'));
    const videoCandidates = videos.map((video) => {
      const href = Model.allowedMediaUrl(video.currentSrc || video.src);
      return href ? { url: href, mime: 'video/mp4', width: video.videoWidth || 0, height: video.videoHeight || 0, bitrate: 0, sizeBytes: 0, source: 'dom', backupUrls: [] } : null;
    }).filter(Boolean);
    const poster = Model.allowedMediaUrl(videos[0]?.poster || '') || imageCandidates[0]?.url || '';
    if (!imageCandidates.length && !videoCandidates.length && !poster) return null;
    const authorName = Model.usernameFromUrl(link?.href || location.href) || route.username || '';
    const caption = images.map((image) => image.alt).find((value) => value && value.length > 8 && value.length < 1000) || '';
    const type = videoCandidates.length || videos.length ? 'video' : 'image';
    return {
      id: shortcode,
      shortcode,
      pageUrl: link?.href || location.href,
      title: Model.postTitle(caption, shortcode),
      caption,
      publishTime: '',
      kind: type,
      author: { id: '', username: authorName, displayName: authorName, avatar: '' },
      authors: authorName ? [{ username: authorName, displayName: authorName }] : [],
      expectedMediaCount: Math.max(1, videoCandidates.length || (imageCandidates.length ? 1 : 0)),
      isPartial: !videoCandidates.length && type === 'video',
      media: [{
        id: shortcode + '-1',
        index: 1,
        type,
        posterUrl: poster,
        imageCandidates,
        videoCandidates
      }]
    };
  }

  function mergePost(target, extra) {
    if (!extra) return target;
    const media = (extra.media?.length > (target.media?.length || 0)) ? extra.media : (target.media?.length ? target.media : extra.media);
    return {
      ...target,
      ...extra,
      title: target.title && !/^Post\s/i.test(target.title) ? target.title : (extra.title || target.title),
      pageUrl: target.pageUrl || extra.pageUrl,
      author: { ...(extra.author || {}), ...(target.author || {}) },
      media: media || []
    };
  }

  function buildSnapshot() {
    scanScripts();
    const route = Model.routeFromUrl(location.href);
    let snapshot = Model.snapshotFromCollected(route, collected);
    if (route.kind === 'profile') {
      const ids = profileCaptures.get(profileCaptureKey()) || new Set();
      if (ids.size) snapshot.posts = (snapshot.posts || []).filter((post) => ids.has(post.id));
    }
    if ((route.kind === 'post' || route.kind === 'feed') && !snapshot.post) {
      const fallback = domPost(route);
      if (fallback) snapshot.post = fallback;
    } else if (snapshot.post && (route.kind === 'feed' || route.kind === 'post')) {
      const fallback = domPost(route);
      if (fallback && fallback.shortcode && snapshot.post.shortcode && fallback.shortcode !== snapshot.post.shortcode && route.kind === 'feed') {
        snapshot.post = fallback;
      } else if (fallback && (!snapshot.post.media || snapshot.post.media.length < fallback.media.length)) {
        snapshot.post = mergePost(snapshot.post, fallback);
      }
    }
    snapshot.url = location.href;
    return snapshot;
  }

  function emit(force) {
    const payload = buildSnapshot();
    const json = JSON.stringify(payload);
    if (!force && json === lastSnapshotJson && location.href === lastUrl) return;
    lastSnapshotJson = json;
    lastUrl = location.href;
    window.postMessage({ source: SOURCE, version: 1, type: 'SNAPSHOT', payload }, location.origin);
  }

  function queueEmit() {
    if (scheduled) return;
    scheduled = 1;
    setTimeout(() => {
      scheduled = 0;
      emit();
    }, 180);
  }

  function facebookRequest(value) {
    try {
      const url = new URL(String(value || ''), location.href);
      return /(^|\.)facebook\.com$|(^|\.)fb\.watch$/i.test(url.hostname) ? url : null;
    } catch (_) { return null; }
  }

  function installNetworkHooks() {
    const rawJsonParse = JSON.parse;
    JSON.parse = function facebookParse(text, reviver) {
      const data = rawJsonParse.apply(this, arguments);
      if (hideFeedAds && typeof text === 'string' && /sponsored_data|SPONSORED|sponsor_relationship|"ad_id"\s*:/i.test(text) &&
          Model.routeFromUrl(location.href).kind === 'feed') {
        Model.filterTimelineAds(data);
      }
      return data;
    };
    const rawFetch = window.fetch;
    if (typeof rawFetch === 'function' && !rawFetch.__facebookDownloaderHook) {
      const hooked = function patchedFetch(input, init) {
        const request = rawFetch.apply(this, arguments).then(async (response) => {
          const url = facebookRequest(input?.url || input);
          if (!hideFeedAds || Model.routeFromUrl(location.href).kind !== 'feed' || !url || !response.ok) return response;
          const type = response.headers.get('content-type') || '';
          if (!/(?:json|javascript|text\/plain)/i.test(type)) return response;
          try {
            const original = await response.clone().text();
            if (!/sponsored_data|SPONSORED|sponsor_relationship|"ad_id"\s*:/i.test(original)) return response;
            const payloads = parsePayloadText(original);
            if (payloads.length !== 1) return response;
            if (!Model.filterTimelineAds(payloads[0])) return response;
            const headers = new Headers(response.headers);
            headers.delete('content-length');
            headers.delete('content-encoding');
            const filtered = new Response(JSON.stringify(payloads[0]), { status: response.status, statusText: response.statusText, headers });
            Object.defineProperties(filtered, { url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type } });
            return filtered;
          } catch (_) { return response; }
        });
        try {
          const url = facebookRequest(input?.url || input);
          if (url) {
            request.then((response) => {
              try {
                const clone = response.clone();
                const type = clone.headers.get('content-type') || '';
                if (/json|javascript|text\/plain/i.test(type)) {
                  clone.text().then((body) => {
                    parsePayloadText(body).forEach((payload) => ingest(payload));
                    queueEmit();
                  }).catch(() => {});
                } else if (/html/i.test(type)) {
                  clone.text().then((html) => {
                    Model.parseHtmlPayloads(html).forEach((payload) => ingest(payload));
                    queueEmit();
                  }).catch(() => {});
                }
              } catch (_) {}
            }).catch(() => {});
          }
        } catch (_) {}
        return request;
      };
      hooked.__facebookDownloaderHook = true;
      window.fetch = hooked;
    }
    const rawOpen = XMLHttpRequest.prototype.open;
    const rawSend = XMLHttpRequest.prototype.send;
    if (!XMLHttpRequest.prototype.__facebookDownloaderHook) {
      XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
        this.__facebookDownloaderUrl = String(url || '');
        return rawOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function patchedSend() {
        this.addEventListener('load', function onLoad() {
          try {
            const url = facebookRequest(this.__facebookDownloaderUrl);
            if (!url) return;
            parseMaybeJson(this.responseType === 'json' ? this.response : this.responseText);
            queueEmit();
          } catch (_) {}
        });
        return rawSend.apply(this, arguments);
      };
      XMLHttpRequest.prototype.__facebookDownloaderHook = true;
    }
  }

  function resolvePost(input) {
    const url = Model.permalinkUrl(input);
    if (!url) return Promise.resolve(null);
    const code = input.shortcode || Model.shortcodeOf(url);
    const captured = [...collected.posts.values()].find((post) => post.shortcode === code && post.media?.length && post.media.every((media) => (media.type === 'video' ? media.videoCandidates : media.imageCandidates)?.length));
    if (captured) return Promise.resolve(captured);
    const cached = detailCache.get(url);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return Promise.resolve(cached.post);
    if (cached) detailCache.delete(url);
    if (Date.now() - (detailFailures.get(url) || 0) < 20000) return Promise.resolve(null);
    if (typeof window.fetch !== 'function') return Promise.resolve(null);
    const controller = new AbortController();
    resolveControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 8000);
    return window.fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const html = await response.text();
      const local = { posts: new Map(), stories: [], creators: [], seen: new WeakSet(), consumed: new Set(), count: 0 };
      Model.parseHtmlPayloads(html).forEach((payload) => {
        Model.collectFromJson(payload, local, { pageUrl: url });
        ingest(payload);
      });
      const route = Model.routeFromUrl(url);
      const snapshot = Model.snapshotFromCollected(route, local.posts.size ? local : collected);
      const post = [snapshot.post, ...local.posts.values()].find((item) => item?.shortcode === route.shortcode) || null;
      if (post) {
        detailCache.set(url, { post, at: Date.now() });
        while (detailCache.size > 30) detailCache.delete(detailCache.keys().next().value);
      }
      queueEmit();
      return post || null;
    }).catch(() => {
      detailFailures.set(url, Date.now());
      return null;
    }).finally(() => { clearTimeout(timeout); resolveControllers.delete(controller); });
  }

  function pumpResolve() {
    while (resolveActive < 2 && resolveQueue.length) {
      const job = resolveQueue.shift();
      if (!job) break;
      resolveActive += 1;
      resolvePost(job.post).then((post) => {
        window.postMessage({
          source: SOURCE,
          type: 'RESOLVE_RESULT',
          epoch: job.epoch,
          requestId: job.requestId,
          post
        }, location.origin);
      }).finally(() => {
        resolveActive -= 1;
        pumpResolve();
      });
    }
  }

  function hookHistory() {
    const wrap = (method) => {
      const raw = history[method];
      if (typeof raw !== 'function' || raw.__facebookDownloaderHook) return;
      const hooked = function patchedHistory() {
        const result = raw.apply(this, arguments);
        queueEmit();
        return result;
      };
      hooked.__facebookDownloaderHook = true;
      history[method] = hooked;
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', queueEmit);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== CONTENT_SOURCE) return;
    if (event.data.type === 'AD_SETTINGS') hideFeedAds = event.data.hideAds === true;
    if (event.data.type === 'GET_SNAPSHOT') emit(true);
    if (event.data.type === 'CANCEL_RESOLVE') {
      resolveQueue.length = 0;
      resolveControllers.forEach((controller) => controller.abort());
    }
    if (event.data.type === 'RESOLVE_POSTS') {
      resolveEpoch = Number(event.data.epoch) || resolveEpoch;
      (Array.isArray(event.data.posts) ? event.data.posts : []).forEach((post) => {
        resolveQueue.push({ post, epoch: resolveEpoch, requestId: event.data.requestId || '' });
      });
      pumpResolve();
    }
  });

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => [...mutation.addedNodes, ...mutation.removedNodes].some((item) =>
      item.nodeType === 1 && !item.closest?.('#facebook-dl-root, .x-dl-post-entry') && item.id !== 'facebook-dl-root' && !item.classList?.contains('x-dl-post-entry')))) queueEmit();
  });
  try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}

  installNetworkHooks();
  window.postMessage({ source: SOURCE, type: 'AD_SETTINGS_REQUEST' }, location.origin);
  hookHistory();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => emit(true), { once: true });
  else emit(true);
  setInterval(() => {
    if (location.href !== lastUrl) queueEmit();
  }, 500);
})();
