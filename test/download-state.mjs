import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../content/content.js', import.meta.url), 'utf8');
const calls = [];
const timers = new Map();
let timerId = 0;
let listener;
const context = vm.createContext({
  Map, setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
  clearTimeout(id) { timers.delete(id); },
  refreshSavedMarks: async () => calls.push('marks'), renderView: () => calls.push('view'),
  refreshJobPanel: async () => calls.push('jobs'),
  EXT: { storage: { onChanged: { addListener(callback) { listener = callback; } } } },
});
const start = source.indexOf('  let downloadStateTimer =');
vm.runInContext(source.slice(start, source.indexOf('\n  DownloaderKit.i18n?.ready', start)), context);
const flush = async () => {
  const pending = [...timers.values()]; timers.clear();
  for (const timer of pending) await timer.callback();
};
listener({ 'facebook-dl-tasks-v1': {
  oldValue: [{ id: 'one', status: 'downloading' }], newValue: [{ id: 'one', status: 'completed' }],
}}, 'local');
await flush();
assert.deepEqual(calls, ['marks', 'view'], 'completion must refresh saved markers before rendering');
calls.length = 0;
listener({ 'facebook-dl-completed-keys-v1': { newValue: ['one'] } }, 'local');
listener({ 'facebook-dl-tasks-v1': {
  oldValue: [{ id: 'two', status: 'downloading' }], newValue: [{ id: 'two', status: 'downloading' }],
}}, 'local');
assert.equal([...timers.values()][0].delay, 100, 'progress cannot downgrade a pending completion refresh');
await flush();
assert.deepEqual(calls, ['marks', 'view']);
calls.length = 0;
listener({ unrelated: {} }, 'local');
listener({ 'facebook-dl-history-v1': {} }, 'sync');
assert.equal(timers.size, 0);

const submitted = [];
Object.assign(context, {
  prefs: { skipDownloaded: true, recordHistory: true },
  pickResource: () => ({ url: 'https://video.twimg.com/video.mp4' }), downloadKey: () => 'one:video',
  mediaExt: () => 'mp4', taskFilename: async () => 'one.mp4', location: { href: 'https://x.com/user' },
  t: key => key, setStatus() {}, completionWatchIds: new Set(),
  send: async (type, message) => { submitted.push(message.tasks[0]); return { added: 1, tasks: message.tasks }; },
});
const enqueueStart = source.indexOf('  async function enqueueMedia(');
vm.runInContext(source.slice(enqueueStart, source.indexOf('  function syncTabs()', enqueueStart)), context);
await context.enqueueMedia({ id: 'one', media: [] }, [{ id: 'video', type: 'video' }], { queue: 'creator' });
assert.equal(submitted[0].forceDuplicate, true, 'manual selection permits redownload even with saved-skip enabled');
await context.enqueueMedia({ id: 'one', media: [] }, [{ id: 'video', type: 'video' }], { respectSkipDownloaded: true });
assert.equal(submitted[1].forceDuplicate, false, 'automatic collection can still skip saved media');
console.log('download state: completion refresh, progress ordering and manual redownload passed');
