import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listeners = { message: [], startup: [], installed: [], storage: [], downloadsChanged: [] };
const stored = {};
const nativeItems = new Map();
const nativeOptions = [];
const cancelledIds = [];
const erasedIds = [];
const createdTabs = [];
const removedTabs = [];
const extensionId = 'test-extension-id';
let nextDownloadId = 1;
let deferNextDownload = null;
let failNextDownload = false;

function event(name) {
  return {
    addListener(listener) { listeners[name].push(listener); },
    removeListener(listener) { listeners[name] = listeners[name].filter((item) => item !== listener); }
  };
}

const storageLocal = {
  async get(keys) {
    if (keys === null || keys === undefined) return { ...stored };
    if (typeof keys === 'string') return { [keys]: stored[keys] };
    if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, stored[key]]));
    const result = {};
    Object.entries(keys).forEach(([key, fallback]) => { result[key] = stored[key] ?? fallback; });
    return result;
  },
  async set(values) {
    const changes = {};
    Object.entries(values).forEach(([key, newValue]) => {
      changes[key] = { oldValue: stored[key], newValue };
      stored[key] = newValue;
    });
    listeners.storage.forEach((listener) => listener(changes, 'local'));
  },
  async remove(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    list.forEach((key) => { delete stored[key]; });
  }
};

const api = {
  runtime: {
    id: extensionId,
    getManifest: () => ({ version: '1.0.0' }),
    onMessage: event('message'),
    onStartup: event('startup'),
    onInstalled: event('installed'),
    async sendMessage() { return { ok: true }; }
  },
  storage: { local: storageLocal, onChanged: event('storage') },
  tabs: {
    create(options, callback) { createdTabs.push(options); callback({ id: 91 }); },
    sendMessage(_id, message, callback) {
      callback({ ok: true, post: {
        shortcode: message.shortcode,
        media: [{ type: 'video', videoCandidates: [{ url: 'https://video.xx.fbcdn.net/resolved.mp4' }] }]
      } });
    },
    remove(id, callback) { removedTabs.push(id); callback(); }
  },
  downloads: {
    onChanged: event('downloadsChanged'),
    async download(options) {
      if (failNextDownload) {
        failNextDownload = false;
        throw new Error('simulated network failure');
      }
      const id = nextDownloadId++;
      nativeOptions.push(options);
      nativeItems.set(id, { id, byExtensionId: extensionId, state: 'in_progress', bytesReceived: 0, totalBytes: 100000, url: options.url });
      if (deferNextDownload) {
        const pending = deferNextDownload;
        deferNextDownload = null;
        await new Promise((resolve) => { pending.resolve = resolve; });
      }
      return id;
    },
    async search(query) {
      const requested = Array.isArray(query) ? query[0] : query;
      return [...nativeItems.values()].filter((item) => !requested?.id || item.id === requested.id).map((item) => ({ ...item }));
    },
    async pause(id) {
      const item = nativeItems.get(id);
      if (!item || item.state !== 'in_progress') throw new Error('download is not active');
      item.state = 'paused';
    },
    async resume(id) {
      const item = nativeItems.get(id);
      if (!item || item.state !== 'paused') throw new Error('download is not paused');
      item.state = 'in_progress';
    },
    async cancel(id) {
      const item = nativeItems.get(id);
      if (item) item.state = 'interrupted';
      cancelledIds.push(id);
    },
    async removeFile() {},
    async erase(query) {
      const id = Array.isArray(query) ? query[0]?.id : query?.id;
      erasedIds.push(id);
      nativeItems.delete(id);
    }
  }
};

const context = vm.createContext({
  chrome: api, browser: undefined, URL, Promise, Date, Math, Set, Map, Object, Array, String, Number, Error, console, setTimeout, clearTimeout,
  importScripts(...files) {
    files.forEach((file) => {
      vm.runInContext(readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    });
  }
});
vm.runInContext(readFileSync(path.join(root, 'background.js'), 'utf8'), context, { filename: 'background.js' });

function send(message) {
  return new Promise((resolve, reject) => {
    let asyncResponse = false;
    for (const listener of listeners.message) {
      const result = listener(message, {}, resolve);
      if (result === true) asyncResponse = true;
      else if (result && typeof result.then === 'function') result.then(resolve, reject);
    }
    if (!asyncResponse) resolve(undefined);
  });
}

const resolvedTab = await send({ type: 'FACEBOOK_DL_RESOLVE_POST_TAB', shortcode: '1234567890123456789' });
assert.equal(resolvedTab.post.shortcode, '1234567890123456789');
assert.equal(createdTabs[0].active, false);
assert.equal(createdTabs[0].url, 'https://www.facebook.com/watch/?v=1234567890123456789');
assert.deepEqual(removedTabs, [91]);

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for ' + label);
}

function task(postId, id, extra = {}) {
  const index = extra.index || 1;
  return {
    id,
    postId,
    mediaId: extra.mediaId || postId + '-' + index,
    index,
    type: extra.type || 'video',
    mediaType: extra.type || 'video',
    author: 'Creator',
    title: extra.title || ('Video ' + postId),
    url: extra.url || ('https://video.xx.fbcdn.net/video-' + postId + '-' + index + '.mp4'),
    pageUrl: 'https://www.facebook.com/watch/?v=' + postId,
    format: extra.type === 'image' ? 'jpg' : 'mp4',
    filename: extra.filename || ('Creator - ' + postId + ' - ' + String(index).padStart(2, '0') + '.mp4'),
    ...extra
  };
}

await storageLocal.set({ 'facebook-dl-settings-v1': { maxConcurrentDownloads: 1 } });

const firstGate = {};
deferNextDownload = firstGate;
await send({ type: 'FACEBOOK_DL_QUEUE_ADD', tasks: [task('1001', 'task-1001')] });
await waitFor(() => nativeOptions.length === 1 && typeof firstGate.resolve === 'function', 'first download start');
const secondAdd = send({ type: 'FACEBOOK_DL_QUEUE_ADD', tasks: [task('1002', 'task-1002')] });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(stored['facebook-dl-tasks-v1'].some((item) => item.postId === '1002'), false, 'serial queue waits');
firstGate.resolve();
await secondAdd;
await waitFor(() => stored['facebook-dl-tasks-v1'].some((item) => item.postId === '1002'), 'second insert');

nativeItems.get(1).state = 'complete';
nativeItems.get(1).bytesReceived = 100;
listeners.downloadsChanged.forEach((listener) => listener({ id: 1, state: { current: 'complete' } }));
await waitFor(() => nativeOptions.length === 2, 'second start');
assert.equal(stored['facebook-dl-history-v1'].filter((item) => item.postId === '1001' && item.status === 'completed').length, 1);

const duplicate = await send({ type: 'FACEBOOK_DL_QUEUE_ADD', tasks: [task('1001', 'duplicate-1001')] });
assert.equal(duplicate.added, 0);

const second = stored['facebook-dl-tasks-v1'].find((item) => item.id === 'task-1002');
nativeItems.get(second.downloadId).state = 'complete';
nativeItems.get(second.downloadId).bytesReceived = 100;
listeners.downloadsChanged.forEach((listener) => listener({ id: second.downloadId, state: { current: 'complete' } }));
await waitFor(() => stored['facebook-dl-tasks-v1'].find((item) => item.id === 'task-1002')?.status === 'completed', 'second complete');

failNextDownload = true;
await send({ type: 'FACEBOOK_DL_QUEUE_ADD', tasks: [task('1004', 'task-1004')] });
await waitFor(() => stored['facebook-dl-tasks-v1'].find((item) => item.id === 'task-1004')?.status === 'failed', 'failed persist');
await send({ type: 'FACEBOOK_DL_QUEUE_CONTROL', id: 'task-1004', action: 'retry' });
await waitFor(() => stored['facebook-dl-tasks-v1'].find((item) => item.id === 'task-1004')?.status === 'downloading', 'retry');
const retried = stored['facebook-dl-tasks-v1'].find((item) => item.id === 'task-1004');
nativeItems.get(retried.downloadId).state = 'complete';
nativeItems.get(retried.downloadId).bytesReceived = 100;
listeners.downloadsChanged.forEach((listener) => listener({ id: retried.downloadId, state: { current: 'complete' } }));
await waitFor(() => stored['facebook-dl-tasks-v1'].find((item) => item.id === 'task-1004')?.status === 'completed', 'retry complete');

const backupTask = {
  ...task('1005', 'task-1005'),
  backupUrls: ['https://video.xx.fbcdn.net/backup-1005.mp4']
};
await send({ type: 'FACEBOOK_DL_QUEUE_ADD', tasks: [backupTask] });
await waitFor(() => stored['facebook-dl-tasks-v1'].find((item) => item.id === 'task-1005')?.status === 'downloading', 'backup primary');
const failedId = stored['facebook-dl-tasks-v1'].find((item) => item.id === 'task-1005').downloadId;
nativeItems.get(failedId).state = 'interrupted';
nativeItems.get(failedId).error = 'SERVER_FORBIDDEN';
listeners.downloadsChanged.forEach((listener) => listener({ id: failedId, state: { current: 'interrupted' } }));
await waitFor(() => stored['facebook-dl-tasks-v1'].find((item) => item.id === 'task-1005')?.url.includes('backup-1005'), 'backup used');
const backupNow = stored['facebook-dl-tasks-v1'].find((item) => item.id === 'task-1005');
nativeItems.get(backupNow.downloadId).state = 'complete';
nativeItems.get(backupNow.downloadId).bytesReceived = 100;
listeners.downloadsChanged.forEach((listener) => listener({ id: backupNow.downloadId, state: { current: 'complete' } }));
await waitFor(() => stored['facebook-dl-tasks-v1'].find((item) => item.id === 'task-1005')?.status === 'completed', 'backup complete');

await send({ type: 'FACEBOOK_DL_QUEUE_ADD', tasks: [task('1009', 'task-1009')] });
await waitFor(() => Number.isInteger(stored['facebook-dl-tasks-v1'].find((item) => item.id === 'task-1009')?.downloadId), 'html start');
const invalid = stored['facebook-dl-tasks-v1'].find((item) => item.id === 'task-1009');
Object.assign(nativeItems.get(invalid.downloadId), { state: 'complete', bytesReceived: 425, totalBytes: 425, filename: 'denied.htm', mime: 'text/html' });
listeners.downloadsChanged.forEach((listener) => listener({ id: invalid.downloadId, state: { current: 'complete' } }));
await waitFor(() => stored['facebook-dl-tasks-v1'].find((item) => item.id === 'task-1009')?.status === 'failed', 'HTML rejected');

const carousel = Array.from({ length: 10 }, (_, index) => task('CARO', 'caro-' + (index + 1), {
  index: index + 1,
  type: index === 2 ? 'video' : 'image',
  url: 'https://' + (index === 2 ? 'video.xx.fbcdn.net/slide-' : 'scontent.xx.fbcdn.net/media/slide-') + (index + 1) + (index === 2 ? '.mp4' : '.jpg'),
  filename: 'Caption - user - ' + String(index + 1).padStart(2, '0') + (index === 2 ? '.mp4' : '.jpg')
}));
await send({ type: 'FACEBOOK_DL_QUEUE_ADD', tasks: carousel });
await waitFor(() => stored['facebook-dl-tasks-v1'].filter((item) => item.postId === 'CARO').length === 10, 'carousel queued');
const ordered = stored['facebook-dl-tasks-v1'].filter((item) => item.postId === 'CARO').sort((a, b) => a.index - b.index);
assert.equal(ordered.map((item) => Number(item.index)).join(','), '1,2,3,4,5,6,7,8,9,10');
assert.equal(ordered[2].type, 'video');
assert.ok(ordered[0].filename.includes('01'));

await send({ type: 'FACEBOOK_DL_QUEUE_BULK', action: 'cancel-all' });
await storageLocal.set({ 'facebook-dl-settings-v1': { maxConcurrentDownloads: 3 } });
const partial = Array.from({ length: 3 }, (_, index) => task('PART', 'part-' + (index + 1), { index: index + 1, mediaId: 'm' + index, type: 'image', url: 'https://scontent.xx.fbcdn.net/media/p' + index + '.jpg', filename: 'p-' + String(index + 1).padStart(2, '0') + '.jpg' }));
await send({ type: 'FACEBOOK_DL_QUEUE_ADD', tasks: partial });
await waitFor(() => stored['facebook-dl-tasks-v1'].filter((item) => item.postId === 'PART' && Number.isInteger(item.downloadId)).length === 3, 'partial started');
for (const item of stored['facebook-dl-tasks-v1'].filter((row) => row.postId === 'PART')) {
  const fail = item.index === 2;
  Object.assign(nativeItems.get(item.downloadId), fail
    ? { state: 'interrupted', error: 'NETWORK_FAILED' }
    : { state: 'complete', bytesReceived: 5000, totalBytes: 5000 });
  listeners.downloadsChanged.forEach((listener) => listener({ id: item.downloadId, state: { current: fail ? 'interrupted' : 'complete' } }));
}
await waitFor(() => stored['facebook-dl-tasks-v1'].filter((item) => item.postId === 'PART' && item.status === 'failed').length === 1, 'partial failures recorded');
const completedBefore = stored['facebook-dl-history-v1'].filter((item) => item.postId === 'PART' && item.status === 'completed').length;
assert.equal(completedBefore, 2, 'successful media items stay saved');
await send({ type: 'FACEBOOK_DL_QUEUE_BULK', action: 'retry-failed' });
assert.equal(stored['facebook-dl-history-v1'].filter((item) => item.postId === 'PART' && item.status === 'completed').length, 2);


await send({ type: 'FACEBOOK_DL_QUEUE_BULK', action: 'cancel-all' });
await send({type:'FACEBOOK_DL_QUEUE_ADD',tasks:[task('NOHISTORY','no-history',{recordHistory:false})]});
await waitFor(()=>stored['facebook-dl-tasks-v1'].find(item=>item.id==='no-history')?.downloadId,'history-disabled download start');
const noHistoryTask=stored['facebook-dl-tasks-v1'].find(item=>item.id==='no-history');
Object.assign(nativeItems.get(noHistoryTask.downloadId),{state:'complete',bytesReceived:5000,totalBytes:5000});
listeners.downloadsChanged.forEach(listener=>listener({id:noHistoryTask.downloadId,state:{current:'complete'}}));
await waitFor(()=>stored['facebook-dl-completed-keys-v1']?.includes('NOHISTORY:NOHISTORY-1:1:video'),'independent completion index');
assert.equal(stored['facebook-dl-history-v1'].some(item=>item.postId==='NOHISTORY'),false);
const noHistoryDuplicate=await send({type:'FACEBOOK_DL_QUEUE_ADD',tasks:[task('NOHISTORY','no-history-again',{recordHistory:false})]});
assert.equal(noHistoryDuplicate.added,0,'completed media is skipped even with history disabled');
const redownload = await send({ type: 'FACEBOOK_DL_QUEUE_ADD', tasks: [task('1001', 'redownload-1001', { forceDuplicate: true })] });
assert.equal(redownload.added, 1, 'an explicitly requested redownload is queued');
const activeRedownload = await send({ type: 'FACEBOOK_DL_QUEUE_ADD', tasks: [task('1001', 'redownload-1001-again', { forceDuplicate: true })] });
assert.equal(activeRedownload.added, 0, 'redownload permission must still reject an active duplicate');
await send({ type: 'FACEBOOK_DL_DATA_CLEAR', scope: 'all' });
assert.equal(stored['facebook-dl-tasks-v1'], undefined);

console.log('facebook queue serialization, media-item dedupe, carousel order, backup, HTML reject and partial retry passed');
