if (typeof importScripts === 'function') {
  importScripts('shared/runtime.js', 'shared/i18n.js', 'shared/remote-content.js', 'shared/config-handler.js');
}

// The queue is deliberately self-contained: service workers can stop at any time,
// so the storage copy is always the source of truth.
const EXT = DownloaderKit.runtime.getApi();
const TASKS_KEY = 'facebook-dl-tasks-v1';
const HISTORY_KEY = 'facebook-dl-history-v1';
const SETTINGS_KEY = 'facebook-dl-settings-v1';
const CONFIG_URL = 'http://124.222.62.190:8081/api/config/facebook';
const CONFIG_MESSAGE = 'FACEBOOK_DL_FETCH_JSON';
const ACTIVE = new Set(['resolving', 'waiting', 'downloading', 'paused']);
const FINISHED = new Set(['completed', 'failed', 'cancelled']);
let work = Promise.resolve();
let scheduling = false;
const pageInfoByTab = new Map();

// IndexedDB belongs to the extension origin, independent of X page storage.
let resourceDbPromise;
function resourceDb() {
  if (!resourceDbPromise) resourceDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('facebook-resource-cache', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('posts', { keyPath: 'shortcode' });
      store.createIndex('savedAt', 'savedAt');
      request.result.createObjectStore('meta');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { resourceDbPromise = null; reject(request.error); };
  });
  return resourceDbPromise;
}
async function resourceCacheRead(codes) {
  const db = await resourceDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('posts', 'readonly');
    const posts = [];
    [...new Set(codes)].slice(0, 300).forEach((code) => {
      const request = tx.objectStore('posts').get(code);
      request.onsuccess = () => {
        const entry = request.result;
        if (entry && entry.post?.cacheVersion === 3 && Date.now() - entry.savedAt < 30 * 86400000) posts.push(entry.post);
      };
    });
    tx.oncomplete = () => resolve({ ok: true, posts });
    tx.onerror = () => reject(tx.error);
  });
}
async function resourceCacheWrite(post) {
  if (!/^(?:pfbid[A-Za-z0-9]+|\d{5,25}|[A-Za-z0-9_-]{6,120})$/.test(post?.shortcode || '')) return { ok: false };
  const bytes = new TextEncoder().encode(JSON.stringify(post)).length;
  if (bytes > 256 * 1024) return { ok: false };
  const db = await resourceDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['posts', 'meta'], 'readwrite');
    const store = tx.objectStore('posts');
    const meta = tx.objectStore('meta');
    const oldRequest = store.get(post.shortcode);
    oldRequest.onsuccess = () => {
      const totalsRequest = meta.get('totals');
      totalsRequest.onsuccess = () => {
        const totals = totalsRequest.result || { count: 0, bytes: 0 };
        totals.count += oldRequest.result ? 0 : 1;
        totals.bytes += bytes - (oldRequest.result?.bytes || 0);
        store.put({ shortcode: post.shortcode, post, bytes, savedAt: Date.now() });
        const cursorRequest = store.index('savedAt').openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor && (totals.count > 10000 || totals.bytes > 64 * 1024 * 1024 || Date.now() - cursor.value.savedAt > 30 * 86400000)) {
            totals.count -= 1;
            totals.bytes -= cursor.value.bytes;
            cursor.delete();
            cursor.continue();
          } else meta.put(totals, 'totals');
        };
      };
    };
    tx.oncomplete = () => resolve({ ok: true });
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function rememberPageInfo(tabId, url, info) {
  if (!Number.isInteger(tabId) || !info || typeof info !== 'object') return;
  pageInfoByTab.set(tabId, { url: String(url || ''), info, at: Date.now() });
}

EXT.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'FACEBOOK_DL_CACHE_READ' || message?.type === 'FACEBOOK_DL_CACHE_WRITE') {
    const operation = message.type === 'FACEBOOK_DL_CACHE_READ'
      ? resourceCacheRead(Array.isArray(message.codes) ? message.codes : []) : resourceCacheWrite(message.post);
    operation.then(respond, (error) => respond({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === 'FACEBOOK_DL_PAGE_INFO') {
    rememberPageInfo(sender.tab?.id, message.url || sender.tab?.url, message.info);
    respond({ ok: true });
    return false;
  }
  if (message?.type === 'FACEBOOK_DL_READ_PAGE_INFO') {
    const hit = pageInfoByTab.get(message.tabId);
    const fresh = Boolean(hit?.info) && Date.now() - Number(hit.at || 0) < 5 * 60 * 1000;
    respond(fresh ? { ok: true, info: hit.info, url: hit.url } : { ok: false });
    return false;
  }
  if (message?.type === 'FACEBOOK_DL_RESOLVE_POST_TAB') {
    resolvePostInTab(message).then(respond, (error) => respond({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  return undefined;
});

async function resolvePostInTab(message) {
  const shortcode = text(message?.shortcode || message?.tweetId, 160);
  if (!/^(?:pfbid[A-Za-z0-9]+|\d{5,25}|[A-Za-z0-9_-]{6,120})$/.test(shortcode)) return { ok: false };
  const username = text(message?.username || message?.author, 80).replace(/^@/, '');
  const pageUrl = text(message?.pageUrl, 300);
  let url = '';
  try {
    const parsed = new URL(pageUrl);
    if (/(^|\.)facebook\.com$/i.test(parsed.hostname) || /(^|\.)fb\.watch$/i.test(parsed.hostname)) url = parsed.href;
  } catch (_) {}
  if (!url && username && /^pfbid/i.test(shortcode)) url = 'https://www.facebook.com/' + encodeURIComponent(username) + '/posts/' + shortcode;
  else if (!url && username && /^\d+$/.test(shortcode)) url = 'https://www.facebook.com/' + encodeURIComponent(username) + '/videos/' + shortcode;
  else if (!url) url = 'https://www.facebook.com/watch/?v=' + shortcode;
  if (!EXT.tabs?.create || !EXT.tabs?.sendMessage || !EXT.tabs?.remove) return { ok: false };
  const tabCall = (name, args) => {
    if (typeof browser !== 'undefined' && EXT === browser) return EXT.tabs[name](...args);
    return new Promise((resolve, reject) => EXT.tabs[name](...args, (value) => {
      const error = EXT.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(value);
    }));
  };
  const created = await tabCall('create', [{ url, active: false }]);
  if (!Number.isInteger(created?.id)) return { ok: false };
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const result = await tabCall('sendMessage',
        [created.id, { type: 'FACEBOOK_DL_GET_POST', shortcode }]).catch(() => null);
      const post = result?.post;
      const hasResource = !post?.isPartial && post?.media?.length && (!post.expectedMediaCount || post.media.length >= post.expectedMediaCount) && post.media.every((media) => {
        const candidates = media.type === 'video' || media.type === 'gif' ? media.videoCandidates : media.imageCandidates;
        return (candidates || []).some((candidate) => allowedMediaUrl(candidate.url));
      });
      if (post?.shortcode === shortcode && hasResource) return { ok: true, post };
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
    return { ok: false };
  } finally {
    await tabCall('remove', [created.id]).catch(() => {});
  }
}

DownloaderKit.attachConfigHandler(EXT, {
  configUrl: CONFIG_URL,
  messageType: CONFIG_MESSAGE
});

function serial(task) {
  const next = work.then(task, task);
  work = next.catch(() => {});
  return next;
}

function requestSchedule() {
  serial(schedule).catch(() => {});
}

function now() { return Date.now(); }

async function t(key, values) {
  await DownloaderKit.i18n.ready;
  return DownloaderKit.i18n.t(key, values);
}

function text(value, limit) {
  return String(value || '').trim().slice(0, limit || 500);
}

function fileExtension(task) {
  const fallback = task?.type === 'image' || task?.type === 'cover' ? 'jpg' : 'mp4';
  const raw = String(task?.format || fallback).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(raw) ? raw : fallback;
}

function withExtension(name, ext) {
  const match = String(name || '').match(/\.([a-z0-9]{1,8})$/i);
  const fileExt = match ? match[1].toLowerCase() : ext;
  const base = (match ? String(name).slice(0, -match[0].length) : String(name || '')).replace(/[. ]+$/g, '');
  const room = Math.max(1, 180 - fileExt.length - 1);
  return (base.slice(0, room) || 'facebook') + '.' + fileExt;
}

function safeFilename(value, task) {
  const ext = fileExtension(task);
  const fallback = `${text(task?.author || task?.creatorId, 80) || 'facebook'}-${text(task?.postId || task?.videoId, 120) || 'download'}.${ext}`;
  const raw = text(value, 240);
  if (!raw) return fallback;
  // Chrome accepts forward-slash relative folders. Validate every component so
  // creatorFolders can keep `Facebook Downloads/<creator>/...` without allowing
  // traversal or an empty path component.
  const parts = raw.split(/[\\/]/);
  if (!parts.length || parts.some((part) => {
    const trimmed = part.trim();
    return !trimmed || trimmed === '.' || trimmed === '..';
  })) return fallback;
  const clean = parts.map((part, index) => {
    const piece = part.replace(/[:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
    if (index !== parts.length - 1) return piece.replace(/[. ]+$/g, '').slice(0, 80);
    return withExtension(piece, ext);
  });
  if (clean.some((part) => !part || part === '.' || part === '..')) return fallback;
  let joined = clean.join('/');
  if (joined.length > 220) {
    const file = clean[clean.length - 1];
    const fileExt = file.match(/\.([a-z0-9]{1,8})$/i)?.[1] || ext;
    const prefix = clean.slice(0, -1).join('/');
    const room = Math.max(1, 220 - (prefix ? prefix.length + 1 : 0) - fileExt.length - 1);
    const base = file.slice(0, file.length - fileExt.length - 1).slice(0, room);
    joined = (prefix ? prefix + '/' : '') + (base || 'facebook') + '.' + fileExt;
  }
  return joined || fallback;
}

function allowedMediaUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (/(^|\.)facebook\.com$/i.test(host) || /(^|\.)fb\.watch$/i.test(host)) return false;
    return /(^|\.)(fbcdn\.net|fbcdn\.com|fbsbx\.com)$/i.test(host);
  } catch (_) {
    return false;
  }
}

function looksLikeHtmlDump(item) {
  const filename = String(item?.filename || '');
  const mime = String(item?.mime || '');
  return /\.(?:html?|json|xml|txt)$/i.test(filename) || /^(?:text\/|application\/(?:json|xml))/i.test(mime);
}

function invalidCompletedMedia(task, item) {
  if (!item || looksLikeHtmlDump(item) || item.exists === false) return true;
  const minBytes = task.type === 'image' || task.type === 'cover' ? 256 : 1024;
  return Math.max(Number(item.bytesReceived) || 0, Number(item.totalBytes) || 0) < minBytes;
}

async function probeMediaAddress(task) {
  if (!task.validateMedia || task.type !== 'video' || typeof fetch !== 'function') return true;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 10000) : null;
  try {
    const response = await fetch(task.url, {
      method: 'GET', headers: { Range: 'bytes=0-31' }, credentials: 'include', cache: 'no-store',
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok || /^(?:text\/|application\/(?:json|xml))/i.test(response.headers?.get('content-type') || '')) return false;
    let bytes;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const parts = [];
      let length = 0;
      try {
        while (length < 12) {
          const part = await reader.read();
          if (part.done) break;
          parts.push(part.value);
          length += part.value.length;
        }
        bytes = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      } finally { await reader.cancel().catch(() => {}); }
    } else {
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    return !!bytes && bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp';
  } catch (error) {
    debugLog('下载地址预检失败', String(error?.message || error));
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stored() {
  const data = await DownloaderKit.runtime.storageGet([TASKS_KEY, HISTORY_KEY, SETTINGS_KEY, 'facebook-dl-completed-keys-v1'], EXT);
  return {
    tasks: Array.isArray(data?.[TASKS_KEY]) ? data[TASKS_KEY] : [],
    history: Array.isArray(data?.[HISTORY_KEY]) ? data[HISTORY_KEY] : [],
    completedKeys: Array.isArray(data?.['facebook-dl-completed-keys-v1']) ? data['facebook-dl-completed-keys-v1'] : [],
    settings: data?.[SETTINGS_KEY] && typeof data[SETTINGS_KEY] === 'object' ? data[SETTINGS_KEY] : {}
  };
}

async function save(values) {
  const update = {};
  if (values.tasks) update[TASKS_KEY] = values.tasks;
  if (values.history) update[HISTORY_KEY] = values.history;
  if (values.tasks?.some(task => task.status === 'completed')) {
    const existing = await DownloaderKit.runtime.storageGet(['facebook-dl-completed-keys-v1'], EXT);
    update['facebook-dl-completed-keys-v1'] = [...new Set([...(existing['facebook-dl-completed-keys-v1'] || []),
      ...values.tasks.filter(task => task.status === 'completed').map(downloadKeyOf)])].slice(-10000);
  }
  await DownloaderKit.runtime.storageSet(update, EXT);
}

function notify(kind = 'tasks') {
  // No receiver is normal while the popup and content scripts are closed.
  try { Promise.resolve(EXT.runtime.sendMessage({ type: 'FACEBOOK_DL_TASKS_CHANGED', kind })).catch(() => {}); } catch (_) {}
}

function nativeOutcome(item, delta) {
  if (item?.state === 'complete' || delta?.state?.current === 'complete') return 'complete';
  if (item?.state === 'interrupted' || delta?.state?.current === 'interrupted') return 'interrupted';
  return '';
}

function ownedDownload(item) {
  // Firefox may omit byExtensionId. The download ID is already bound to one
  // of our persisted tasks; only reject an explicit different extension ID.
  return !!item && (!item.byExtensionId || item.byExtensionId === EXT.runtime.id);
}

async function syncActiveDownloads(state) {
  let terminal = false;
  for (const task of state.tasks) {
    if (!ACTIVE.has(task.status) || !Number.isInteger(task.downloadId)) continue;
    const item = (await DownloaderKit.runtime.invoke(EXT.downloads.search, EXT.downloads, [{ id: task.downloadId }]).catch(() => []))[0];
    if (!ownedDownload(item)) continue;
    const outcome = nativeOutcome(item, null);
    if (item.paused || task.status === 'paused') {
      task.status = 'paused';
      continue;
    }
    if (!outcome && task.status !== 'downloading') continue;
    task.bytesReceived = item.bytesReceived || 0;
    task.totalBytes = item.totalBytes || 0;
    task.progress = task.totalBytes > 0 ? Math.min(100, Math.round(task.bytesReceived * 100 / task.totalBytes)) : (task.progress || 0);
    if (outcome === 'complete' && !invalidCompletedMedia(task, item)) {
      task.status = 'completed';
      task.progress = 100;
      task.updatedAt = now();
      state.history = appendHistory(state.history, task, 'completed');
      terminal = true;
    } else if ((outcome === 'interrupted' || outcome === 'complete') && task.status === 'downloading') {
      const failedId = task.downloadId;
      const switched = item.error !== 'USER_CANCELED' && nextDownloadAddress(task);
      if (switched) await discardFailedDownload(failedId);
      else {
        task.status = item.error === 'USER_CANCELED' ? 'cancelled' : 'failed';
        task.error = item.error || await t('downloadInterrupted');
        task.updatedAt = now();
        if (task.status === 'failed') {
          state.history = appendHistory(state.history, task, 'failed', task.error);
          await discardFailedDownload(failedId);
        }
      }
      terminal = true;
    }
  }
  return terminal;
}

function historyEntry(task, status, error) {
  return {
    id: task.id,
    downloadId: task.downloadId || null,
    postId: task.postId || task.videoId || '',
    shortcode: task.shortcode || '',
    mediaId: task.mediaId || '',
    index: Number(task.index) || 1,
    totalCount: Number(task.totalCount) || 1,
    mediaType: task.mediaType || task.type || '',
    videoId: task.videoId || task.postId || '',
    creatorId: task.creatorId || '',
    author: task.author || '',
    title: task.title || '',
    publishTime: task.publishTime || '',
    pageUrl: task.pageUrl || '',
    coverUrl: task.coverUrl || '',
    type: task.type,
    format: task.format || '',
    quality: task.quality || '',
    width: Number(task.width) || 0,
    height: Number(task.height) || 0,
    filename: task.filename || '',
    downloadKey: task.downloadKey || '',
    status,
    error: error || '',
    time: now(),
    downloadedAt: status === 'completed' ? now() : 0
  };
}

function appendHistory(history, task, status, error) {
  if (task.recordHistory === false) return history;
  if (history.some((item) => item.id === task.id && item.status === status)) return history;
  history.unshift(historyEntry(task, status, error));
  return history.slice(0, 4000);
}

function cap(settings) {
  const n = Number(settings?.maxConcurrentDownloads);
  return n === 2 || n === 3 ? n : 1;
}

function migrateTaskQueues(tasks) {
  const missing = (Array.isArray(tasks) ? tasks : []).filter((task) => task.queue !== 'current' && task.queue !== 'creator');
  if (!missing.length) return false;
  missing.forEach((task) => { task.queue = task.queue === 'video' ? 'current' : (task.queue || 'current'); });
  return true;
}

function downloadKeyOf(input) {
  const postId = text(input?.postId || input?.videoId, 160);
  const mediaType = text(input?.mediaType || input?.type, 20) || 'image';
  const mediaId = text(input?.mediaId, 160);
  const index = String(Number(input?.index) || 1);
  if (mediaId) return [postId, mediaId, index, mediaType].join(':');
  return [postId, index, mediaType].join(':');
}

function sameMediaItem(left, right) {
  if (!left || !right) return false;
  if (left.downloadKey && right.downloadKey) return left.downloadKey === right.downloadKey;
  return downloadKeyOf(left) === downloadKeyOf(right);
}

function normalizeTask(input) {
  const type = ['video', 'image', 'cover'].includes(input?.type) ? input.type : (input?.mediaType === 'video' ? 'video' : 'image');
  const postId = text(input?.postId || input?.videoId, 160);
  const mediaId = text(input?.mediaId, 160);
  const index = Math.max(1, Number(input?.index) || 1);
  const id = text(input?.id, 180) || `${postId}-${mediaId || index}-${type}-${now()}-${Math.random().toString(36).slice(2, 8)}`;
  const primaryUrl = text(input?.url, 4000);
  const backupUrls = [...new Set((Array.isArray(input?.backupUrls) ? input.backupUrls : [])
    .map((value) => text(value, 4000))
    .filter((url) => url !== primaryUrl && allowedMediaUrl(url)))].slice(0, 12);
  const downloadKey = text(input?.downloadKey, 220) || downloadKeyOf({ ...input, postId, mediaId, index, type });
  return {
    id,
    postId,
    shortcode: text(input?.shortcode, 80),
    mediaId,
    index,
    totalCount: Math.max(1, Number(input?.totalCount) || 1),
    mediaType: type === 'cover' ? 'image' : type,
    videoId: postId,
    creatorId: text(input?.creatorId, 160),
    author: text(input?.author, 160),
    title: text(input?.title, 300),
    publishTime: text(input?.publishTime, 80),
    pageUrl: text(input?.pageUrl, 2000),
    url: primaryUrl,
    primaryUrl,
    backupUrls,
    backupIndex: 0,
    type,
    quality: text(input?.quality, 80),
    format: text(input?.format, 30),
    filename: safeFilename(input?.filename, { ...input, type, videoId: postId }),
    coverUrl: text(input?.coverUrl, 4000),
    width: Math.max(0, Number(input?.width) || 0),
    height: Math.max(0, Number(input?.height) || 0),
    downloadKey,
    queue: input?.queue === 'creator' ? 'creator' : 'current',
    validateMedia: input?.validateMedia === true,
    recordHistory: input?.recordHistory !== false,
    status: allowedMediaUrl(primaryUrl) ? 'waiting' : 'resolving',
    progress: 0,
    bytesReceived: 0,
    totalBytes: 0,
    downloadId: null,
    error: '',
    createdAt: now(),
    updatedAt: now()
  };
}

function briefUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const tail = url.pathname.split('/').filter(Boolean).pop() || '';
    return url.hostname + '/' + tail.slice(0, 48);
  } catch (_) {
    return 'invalid-url';
  }
}

function debugLog(message, extra) {
  const line = {
    time: new Date().toISOString().slice(11, 19),
    message,
    extra: extra || ''
  };
  console.log('[FACEBOOK-DL]', line.time, message, extra || '');
  try { Promise.resolve(EXT.runtime.sendMessage({ type: 'FACEBOOK_DL_DEBUG', line })).catch(() => {}); } catch (_) {}
}

async function discardFailedDownload(downloadId) {
  if (!Number.isInteger(downloadId)) return;
  const notes = [];
  try { await DownloaderKit.runtime.invoke(EXT.downloads.cancel, EXT.downloads, [downloadId]); notes.push('已取消'); }
  catch (error) { notes.push('取消失败:' + (error?.message || error)); }
  try { await DownloaderKit.runtime.invoke(EXT.downloads.removeFile, EXT.downloads, [downloadId]); notes.push('已删文件'); }
  catch (error) { notes.push('删文件失败:' + (error?.message || error)); }
  try { await DownloaderKit.runtime.invoke(EXT.downloads.erase, EXT.downloads, [{ id: downloadId }]); notes.push('已清除记录'); }
  catch (error) { notes.push('清除失败:' + (error?.message || error)); }
  debugLog('清除失败下载', 'id=' + downloadId + ' ' + notes.join(' | '));
}

function nextDownloadAddress(task) {
  const index = Number(task.backupIndex) || 0;
  const next = Array.isArray(task.backupUrls) ? task.backupUrls[index] : '';
  if (!allowedMediaUrl(next)) return false;
  task.backupIndex = index + 1;
  task.url = next;
  task.status = 'waiting';
  task.downloadId = null;
  task.error = '';
  task.progress = 0;
  task.bytesReceived = 0;
  task.totalBytes = 0;
  task.updatedAt = now();
  return true;
}

async function schedule() {
  if (scheduling) return;
  scheduling = true;
  try {
    let state = await stored();
    while (state.tasks.filter((task) => task.status === 'downloading').length < cap(state.settings)) {
      const task = state.tasks.find((item) => item.status === 'waiting');
      if (!task) break;
      task.status = 'downloading';
      task.error = '';
      task.updatedAt = now();
      debugLog('开始下载', briefUrl(task.url) + ' 备用' + ((task.backupUrls || []).length - (task.backupIndex || 0)) + '个');
      await save({ tasks: state.tasks }); // Persist before downloads.download so an MV3 restart can recover it.
      notify();
      try {
        if (!await probeMediaAddress(task)) {
          debugLog('跳过无权限或非 MP4 地址', briefUrl(task.url));
          if (!nextDownloadAddress(task)) {
            task.status = 'failed';
            task.error = '下载地址没有返回 MP4 视频';
            task.updatedAt = now();
            state.history = appendHistory(state.history, task, 'failed', task.error);
          }
          await save({ tasks: state.tasks, history: state.history });
          notify(task.status === 'waiting' ? 'tasks' : 'terminal');
          state = await stored();
          continue;
        }
        task.downloadId = await DownloaderKit.runtime.invoke(EXT.downloads.download, EXT.downloads, [{
          url: task.url,
          filename: safeFilename(task.filename, task),
          saveAs: false,
          conflictAction: 'uniquify'
        }]);
        task.updatedAt = now();
        await save({ tasks: state.tasks });
        notify();
        // A tiny download may already be complete before download() returns its ID.
        // Its onChanged callback is serialized behind this scheduler, so inspect
        // the native state now instead of depending on event timing.
        const native = (await DownloaderKit.runtime.invoke(EXT.downloads.search, EXT.downloads, [{ id: task.downloadId }]).catch(() => []))[0];
        if (ownedDownload(native) && native.state === 'complete' && !invalidCompletedMedia(task, native)) {
          task.status = 'completed';
          task.progress = 100;
          task.bytesReceived = native.bytesReceived || 0;
          task.totalBytes = native.totalBytes || 0;
          task.updatedAt = now();
          state.history = appendHistory(state.history, task, 'completed');
          await save({ tasks: state.tasks, history: state.history });
          notify('terminal');
        } else if (ownedDownload(native) && (native.state === 'interrupted'
          || (native.state === 'complete' && invalidCompletedMedia(task, native)))) {
          const failedId = task.downloadId;
          debugLog('下载中断', (native.error || '未知') + ' ' + briefUrl(task.url));
          const switched = native.error !== 'USER_CANCELED' && nextDownloadAddress(task);
          if (switched) {
            debugLog('改用备用地址', briefUrl(task.url));
            await discardFailedDownload(failedId);
          }
          else {
            task.status = native.error === 'USER_CANCELED' ? 'cancelled' : 'failed';
            task.error = native.error || await t('downloadInterrupted');
            task.updatedAt = now();
            if (task.status === 'failed') {
              state.history = appendHistory(state.history, task, 'failed', task.error);
              await discardFailedDownload(failedId);
            }
          }
          await save({ tasks: state.tasks, history: state.history });
          notify(task.status === 'waiting' ? 'tasks' : 'terminal');
        }
      } catch (error) {
        if (nextDownloadAddress(task)) {
          await save({ tasks: state.tasks });
        } else {
          task.status = 'failed';
          task.error = String(error?.message || error);
          task.updatedAt = now();
          state.history = appendHistory(state.history, task, 'failed', task.error);
          await save({ tasks: state.tasks, history: state.history });
        }
        notify();
      }
      state = await stored();
    }
  } finally {
    scheduling = false;
  }
}

async function reconcile() {
  const state = await stored();
  let changed = false;
  for (const task of state.tasks) {
    if (!ACTIVE.has(task.status)) continue;
    // downloads.download may not have returned before MV3 stops. That task has
    // no native download to reconcile, so make it eligible for a fresh start.
    if (!Number.isInteger(task.downloadId)) {
      if (task.status === 'downloading') {
        task.status = 'waiting';
        task.downloadId = null;
        task.updatedAt = now();
        changed = true;
      }
      continue;
    }
    const found = await DownloaderKit.runtime.invoke(EXT.downloads.search, EXT.downloads, [{ id: task.downloadId }]).catch(() => []);
    const item = found[0];
    if (!ownedDownload(item)) {
      if (task.status === 'downloading') { task.status = 'waiting'; task.downloadId = null; task.updatedAt = now(); changed = true; }
      continue;
    }
    task.bytesReceived = item.bytesReceived || 0;
    task.totalBytes = item.totalBytes || 0;
    if (item.state === 'complete' && !invalidCompletedMedia(task, item)) {
      task.status = 'completed'; task.updatedAt = now();
      state.history = appendHistory(state.history, task, 'completed'); changed = true;
    } else if (item.state === 'complete' && invalidCompletedMedia(task, item)) {
      const failedId = task.downloadId;
      debugLog('下载到的是网页而不是视频', briefUrl(task.url));
      const switched = nextDownloadAddress(task);
      if (switched) await discardFailedDownload(failedId);
      else {
        task.status = 'failed';
        task.error = await t('downloadInterrupted');
        task.updatedAt = now();
        state.history = appendHistory(state.history, task, 'failed', task.error);
        await discardFailedDownload(failedId);
      }
      changed = true;
    } else if (item.paused || task.status === 'paused') {
      task.status = 'paused';
      changed = true;
    } else if (item.state === 'interrupted') {
      const failedId = task.downloadId;
      const switched = task.status === 'downloading' && item.error !== 'USER_CANCELED' && nextDownloadAddress(task);
      if (switched) await discardFailedDownload(failedId);
      else {
        task.status = item.error === 'USER_CANCELED' ? 'cancelled' : 'failed';
        task.error = item.error || await t('downloadInterrupted'); task.updatedAt = now();
        if (task.status === 'failed') {
          state.history = appendHistory(state.history, task, 'failed', task.error);
          await discardFailedDownload(failedId);
        }
      }
      changed = true;
    } else if (task.status === 'downloading') changed = true;
  }
  if (changed) { await save({ tasks: state.tasks, history: state.history }); notify('terminal'); }
  requestSchedule();
}

async function holdIncompleteForStartup() {
  const state = await stored();
  let changed = false;
  for (const task of state.tasks) {
    if (task.status === 'waiting') {
      task.status = 'paused';
      task.updatedAt = now();
      changed = true;
    } else if (task.status === 'downloading') {
      if (Number.isInteger(task.downloadId)) {
        try {
          await DownloaderKit.runtime.invoke(EXT.downloads.pause, EXT.downloads, [task.downloadId]);
        } catch (_) {
          await DownloaderKit.runtime.invoke(EXT.downloads.cancel, EXT.downloads, [task.downloadId]).catch(() => {});
          task.downloadId = null;
          task.progress = 0;
          task.bytesReceived = 0;
          task.totalBytes = 0;
        }
      }
      task.status = 'paused';
      task.updatedAt = now();
      changed = true;
    }
  }
  if (changed) { await save({ tasks: state.tasks }); notify(); }
  await reconcile();
}

EXT.downloads.onChanged.addListener((delta) => {
  if (!delta?.id) return;
  serial(async () => {
    const state = await stored();
    const task = state.tasks.find((item) => item.downloadId === delta.id);
    if (!task || FINISHED.has(task.status)) return;
    const item = (await DownloaderKit.runtime.invoke(EXT.downloads.search, EXT.downloads, [{ id: delta.id }]).catch(() => []))[0];
    if (item && !ownedDownload(item)) return;
    if (!item && !delta.state) return;
    if (item) {
      task.bytesReceived = item.bytesReceived || task.bytesReceived || 0;
      task.totalBytes = item.totalBytes || task.totalBytes || 0;
      task.progress = task.totalBytes > 0 ? Math.min(100, Math.round(task.bytesReceived * 100 / task.totalBytes)) : task.progress || 0;
    }
    const outcome = nativeOutcome(item, delta);
    let terminal = false;
    let alternate = false;
    if (outcome === 'complete' && !invalidCompletedMedia(task, item)) {
      task.status = 'completed'; task.progress = 100;
      state.history = appendHistory(state.history, task, 'completed');
      terminal = true;
    } else if (outcome === 'complete' && invalidCompletedMedia(task, item)) {
      const failedId = task.downloadId;
      debugLog('下载到的是网页而不是视频', briefUrl(task.url));
      alternate = task.status === 'downloading' && nextDownloadAddress(task);
      if (alternate) await discardFailedDownload(failedId);
      else {
        task.status = 'failed';
        task.error = await t('downloadInterrupted');
        state.history = appendHistory(state.history, task, 'failed', task.error);
        await discardFailedDownload(failedId);
        terminal = true;
      }
    } else if (outcome === 'interrupted' && (item?.error === 'USER_CANCELED' || task.status === 'cancelled')) {
      task.status = 'cancelled';
      task.error = '';
      terminal = true;
    } else if (item?.paused || task.status === 'paused') {
      task.status = 'paused';
    } else if (outcome === 'interrupted') {
      const failedId = task.downloadId;
      const errorCode = item?.error || '';
      debugLog('下载中断', (errorCode || '未知') + ' ' + briefUrl(task.url));
      alternate = task.status === 'downloading' && errorCode !== 'USER_CANCELED' && nextDownloadAddress(task);
      if (alternate) {
        debugLog('改用备用地址', briefUrl(task.url));
        await discardFailedDownload(failedId);
      }
      else {
        task.status = errorCode === 'USER_CANCELED' || task.status === 'cancelled' ? 'cancelled' : 'failed';
        task.error = errorCode || await t('downloadInterrupted');
        if (task.status === 'failed') {
          state.history = appendHistory(state.history, task, 'failed', task.error);
          await discardFailedDownload(failedId);
        }
        terminal = true;
      }
    }
    task.updatedAt = now();
    await save({ tasks: state.tasks, history: state.history });
    notify(terminal ? 'terminal' : alternate ? 'tasks' : 'progress');
    requestSchedule();
  });
});

async function control(state, id, action) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) throw new Error(await t('taskNotFound'));
  if (action === 'pause' && (task.status === 'downloading' || task.status === 'waiting')) {
    if (task.status === 'downloading' && Number.isInteger(task.downloadId)) {
      try {
        await DownloaderKit.runtime.invoke(EXT.downloads.pause, EXT.downloads, [task.downloadId]);
      } catch (_) {
        await DownloaderKit.runtime.invoke(EXT.downloads.cancel, EXT.downloads, [task.downloadId]).catch(() => {});
        task.downloadId = null;
      }
    }
    task.status = 'paused';
  } else if (action === 'resume' && task.status === 'paused') {
    if (Number.isInteger(task.downloadId)) {
      try {
        await DownloaderKit.runtime.invoke(EXT.downloads.resume, EXT.downloads, [task.downloadId]);
        task.status = 'downloading';
      } catch (_) {
        await DownloaderKit.runtime.invoke(EXT.downloads.cancel, EXT.downloads, [task.downloadId]).catch(() => {});
        task.status = 'waiting';
        task.downloadId = null;
        task.progress = 0;
        task.bytesReceived = 0;
        task.totalBytes = 0;
      }
    } else {
      task.status = 'waiting';
    }
  } else if (action === 'cancel' && !FINISHED.has(task.status)) {
    task.status = 'cancelled';
    if (Number.isInteger(task.downloadId)) await DownloaderKit.runtime.invoke(EXT.downloads.cancel, EXT.downloads, [task.downloadId]).catch(() => {});
  } else if (action === 'retry' && ['failed', 'cancelled'].includes(task.status)) {
    task.status = 'waiting'; task.downloadId = null; task.error = ''; task.progress = 0; task.bytesReceived = 0; task.totalBytes = 0;
    task.url = task.primaryUrl || task.url;
    task.backupIndex = 0;
  } else if (!['pause', 'resume', 'cancel', 'retry'].includes(action)) throw new Error(await t('invalidAction'));
  task.updatedAt = now();
  return task;
}

async function downloadInlineBytes(message) {
  const bytes = message?.bytes;
  const size = Number(bytes?.byteLength) || 0;
  if (size < 256 || size > 8000000) throw new Error('封面不可用');
  const filename = safeFilename(message.filename, { type: 'image', format: 'jpg' });
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  try {
    await DownloaderKit.runtime.invoke(EXT.downloads.download, EXT.downloads, [{
      url,
      filename,
      saveAs: false,
      conflictAction: 'uniquify'
    }]);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  return { ok: true };
}

EXT.runtime.onMessage.addListener((message, _sender, respond) => {
  const type = message?.type;
  if (!String(type || '').startsWith('FACEBOOK_DL_') || type === 'FACEBOOK_DL_FETCH_JSON' || type === 'FACEBOOK_DL_TASKS_CHANGED' || type === 'FACEBOOK_DL_DEBUG' || type === 'FACEBOOK_DL_PAGE_INFO' || type === 'FACEBOOK_DL_READ_PAGE_INFO' || type === 'FACEBOOK_DL_GET_INFO' || type === 'FACEBOOK_DL_RESOLVE_POST_TAB' || type === 'FACEBOOK_DL_GET_POST' || type === 'FACEBOOK_DL_CACHE_READ' || type === 'FACEBOOK_DL_CACHE_WRITE') return undefined;
  serial(async () => {
    if (type === 'FACEBOOK_DL_DOWNLOAD_BYTES') return downloadInlineBytes(message);
    const state = await stored();
    if (type === 'FACEBOOK_DL_QUEUE_LIST') {
      const migrated = migrateTaskQueues(state.tasks);
      const finished = await syncActiveDownloads(state);
      if (finished || migrated) {
        await save({ tasks: state.tasks, history: state.history });
        if (finished) notify('terminal');
      }
      requestSchedule();
      return { ok: true, tasks: state.tasks };
    }
    if (type === 'FACEBOOK_DL_HISTORY_LIST') return { ok: true, history: state.history };
    if (type === 'FACEBOOK_DL_HISTORY_CLEAR') { state.history = []; await save({ history: state.history }); notify('history'); return { ok: true }; }
    if (type === 'FACEBOOK_DL_OPEN_DOWNLOADS') {
      const url = typeof browser !== 'undefined' && browser.runtime?.getBrowserInfo ? 'about:downloads' : 'chrome://downloads/';
      if (!EXT.tabs?.create) throw new Error(await t('cannotOpenDownloads'));
      await DownloaderKit.runtime.invoke(EXT.tabs.create, EXT.tabs, [{ url }]);
      return { ok: true };
    }
    if (type === 'FACEBOOK_DL_DATA_CLEAR') {
      const scope = message.scope;
      if (!['history', 'tasks', 'all'].includes(scope)) throw new Error(await t('invalidClearScope'));
      if (scope === 'history' || scope === 'all') state.history = [];
      if (scope === 'tasks' || scope === 'all') {
        await Promise.all(state.tasks
          .filter((task) => ACTIVE.has(task.status) && Number.isInteger(task.downloadId))
          .map((task) => DownloaderKit.runtime.invoke(EXT.downloads.cancel, EXT.downloads, [task.downloadId]).catch(() => {})));
        state.tasks = scope === 'all' ? [] : state.tasks.filter((task) => task.status === 'completed');
      }
      if (scope === 'all') {
        const local = await DownloaderKit.runtime.storageGet(null, EXT);
        const keys = Object.keys(local || {}).filter((key) => key.startsWith('facebook-dl-'));
        if (keys.length) await DownloaderKit.runtime.invoke(EXT.storage.local.remove, EXT.storage.local, [keys]);
      } else {
        await save({ tasks: state.tasks, history: state.history });
      }
      notify(scope === 'history' || scope === 'all' ? 'history' : 'tasks'); return { ok: true };
    }
    if (type === 'FACEBOOK_DL_QUEUE_ADD') {
      let added = 0; let skipped = 0; let duplicateCount = 0; let invalidCount = 0;
      for (const input of Array.isArray(message.tasks) ? message.tasks : []) {
        const task = normalizeTask(input);
        const duplicate = state.tasks.some((item) => item.id === task.id)
          || state.tasks.some((item) => !FINISHED.has(item.status) && sameMediaItem(item, task))
          || (!input?.forceDuplicate && (state.completedKeys.includes(downloadKeyOf(task)) || state.history.some((item) => item.status === 'completed' && sameMediaItem(item, task))));
        if (!task.postId || (!allowedMediaUrl(task.url) && !task.pageUrl)) { skipped += 1; invalidCount += 1; continue; }
        if (duplicate) { skipped += 1; duplicateCount += 1; continue; }
        state.tasks.push(task); added += 1;
      }
      await save({ tasks: state.tasks }); notify();
      requestSchedule();
      return { ok: true, added, skipped, duplicateCount, invalidCount, tasks: state.tasks };
    }
    if (type === 'FACEBOOK_DL_QUEUE_RESOLVE') {
      const task = state.tasks.find((item) => item.id === text(message.id, 180));
      if (!task) throw new Error(await t('taskNotFound'));
      const url = text(message.url, 4000);
      const backups = [...new Set((Array.isArray(message.backupUrls) ? message.backupUrls : [])
        .map((value) => text(value, 4000))
        .filter((item) => item && item !== url && allowedMediaUrl(item)))].slice(0, 12);
      if (!allowedMediaUrl(url)) {
        task.status = 'failed';
        task.error = await t('needReopen', { count: 1 });
        task.updatedAt = now();
        state.history = appendHistory(state.history, task, 'failed', task.error);
      } else {
        task.url = url;
        task.primaryUrl = url;
        task.backupUrls = backups;
        task.backupIndex = 0;
        task.status = 'waiting';
        task.error = '';
        task.updatedAt = now();
      }
      await save({ tasks: state.tasks, history: state.history }); notify(); requestSchedule();
      return { ok: true, task };
    }
    if (type === 'FACEBOOK_DL_QUEUE_CONTROL') {
      const task = await control(state, text(message.id, 160), message.action);
      await save({ tasks: state.tasks }); notify(); requestSchedule();
      return { ok: true, task };
    }
    if (type === 'FACEBOOK_DL_QUEUE_DELETE') {
      const id = text(message.id, 160);
      const task = state.tasks.find((item) => item.id === id);
      if (!task) throw new Error(await t('taskNotFound'));
      if (ACTIVE.has(task.status) && Number.isInteger(task.downloadId)) {
        await DownloaderKit.runtime.invoke(EXT.downloads.cancel, EXT.downloads, [task.downloadId]).catch(() => {});
      }
      state.tasks = state.tasks.filter((item) => item.id !== id);
      await save({ tasks: state.tasks });
      notify();
      requestSchedule();
      return { ok: true, tasks: state.tasks };
    }
    if (type === 'FACEBOOK_DL_QUEUE_BULK') {
      const action = message.action;
      if (!['pause-all', 'resume-all', 'cancel-waiting', 'cancel-all', 'retry-failed', 'clear-completed'].includes(action)) throw new Error(await t('invalidBulkAction'));
      migrateTaskQueues(state.tasks);
      const scope = message.queue === 'creator' || message.queue === 'current' || message.queue === 'video' ? (message.queue === 'video' ? 'current' : message.queue) : '';
      for (const task of [...state.tasks]) {
        if (scope && task.queue !== scope) continue;
        if (action === 'pause-all' && (task.status === 'downloading' || task.status === 'waiting')) await control(state, task.id, 'pause');
        if (action === 'resume-all' && task.status === 'paused') await control(state, task.id, 'resume');
        if (action === 'cancel-waiting' && task.status === 'waiting') await control(state, task.id, 'cancel');
        if (action === 'cancel-all' && !FINISHED.has(task.status)) await control(state, task.id, 'cancel');
        if (action === 'retry-failed' && task.status === 'failed') await control(state, task.id, 'retry');
      }
      if (action === 'clear-completed') state.tasks = state.tasks.filter((task) => task.status !== 'completed');
      await save({ tasks: state.tasks }); notify(); requestSchedule();
      return { ok: true, tasks: state.tasks };
    }
    return undefined;
  }).then(respond, (error) => respond({ ok: false, error: String(error?.message || error) }));
  return true;
});

EXT.runtime.onStartup?.addListener(() => { serial(holdIncompleteForStartup); });
EXT.runtime.onInstalled?.addListener((details) => {
  if (details?.reason === 'install') serial(reconcile);
  else if (details?.reason === 'update') serial(holdIncompleteForStartup);
});
EXT.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes?.[SETTINGS_KEY]) serial(schedule);
});
