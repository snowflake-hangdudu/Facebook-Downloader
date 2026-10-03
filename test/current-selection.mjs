import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual renderer and button handlers, including repeated renders.
const source = readFileSync(new URL('../content/content.js', import.meta.url), 'utf8');
const renderer = source.slice(source.indexOf('  function renderCurrent() {'), source.indexOf('  function mergeCreatorPosts('));
const controls = [];
const elements = [];
const element = () => ({ classList: { add() {} }, addEventListener(type, callback) { this[type] = callback; }, replaceChildren() {} });
const context = vm.createContext({
  Set, snapshot: { kind: 'feed', stories: [] }, viewedPost: {}, viewedPostLoading: false, viewedPostToken: 1,
  selectedMedia: new Set(), mediaSelectionPost: '', currentBody: element(),
  post: { shortcode: 'one', author: { username: 'creator' }, media: [1, 2, 3].map(index => ({ index, type: 'image' })) },
  t: key => key, currentPost() { return context.post; }, downloadKey: (post, media) => `${post.shortcode}:${media.index}`,
  isReelPage: () => false, document: { querySelectorAll: () => [] }, showCreatorVideoCover() {},
  postCoverShape: () => '', viewedPostArticle: null,
  authorLabel: (author) => author?.displayName || author?.username || '',
  cleanHandle: (value) => String(value || ''),
  pageType: () => 'image', pageTypeLabel: () => 'Photo', coverUrl: () => '', setMediaPreview() {}, creatorReady: () => true,
  completedKeys: async () => new Set(['one:1', 'one:2', 'one:3']),
  Model: { profileUrl: (name) => 'https://www.facebook.com/' + name },
  node(parent, tag, cls, text) { const el = element(); el.tag = tag; el.text = text; elements.push(el); return el; },
  button(parent, label, cls, callback) { const el = element(); el.label = label; el.callback = callback; controls.push(el); return el; },
  enqueueMedia() {},
});
vm.runInContext(renderer, context);
const render = () => { controls.length = 0; elements.length = 0; context.renderCurrent(); };
const click = async label => { await controls.findLast(control => control.label === label).callback(); };
render();
assert.equal(context.selectedMedia.size, 3);
await click('clearShort');
assert.equal(context.selectedMedia.size, 0);
assert.equal(controls.findLast(control => control.label === 'downloadSelected').disabled, true);
render();
assert.equal(context.selectedMedia.size, 0, 'a redraw must preserve explicit empty selection');
await click('selectAllShort');
assert.equal(context.selectedMedia.size, 3);
await click('selectNewShort');
assert.equal(context.selectedMedia.size, 0, 'all downloaded items must remain unselected');
context.post = { ...context.post, shortcode: 'two' };
render();
assert.equal(context.selectedMedia.size, 3, 'a new post gets the initial default selection');
const checks = elements.filter(el => el.tag === 'input');
for (const check of checks) { check.checked = false; check.change(); }
assert.equal(context.selectedMedia.size, 0);
assert.equal(controls.findLast(control => control.label === 'downloadSelected').disabled, true);
console.log('current selection: clear, empty filters, redraw, new post and download disabling passed');

// Returning from a tweet to the profile entry must invalidate pending tweet work.
const calls = [];
const entryContext = vm.createContext({
  Model: { routeFromUrl: () => ({ kind: entryContext.routeKind }) }, location: { href: 'https://x.com/creator/media' },
  routeKind: 'profile', viewedPostToken: 7, viewedPost: { shortcode: 'one' }, viewedPostArticle: {},
  viewedPostLoading: true, activeMode: 'current',
  shell: { showHome: () => calls.push('home'), open: () => calls.push('open') },
  scanDomCreatorPosts: () => calls.push('scan'), renderView: () => calls.push('render'),
});
const entryStart = source.indexOf('  function openProfileBatch() {');
vm.runInContext(source.slice(entryStart, source.indexOf('\n  function ', entryStart + 5)), entryContext);
assert.equal(entryContext.openProfileBatch(), true);
assert.equal(entryContext.activeMode, 'creator');
assert.equal(entryContext.viewedPost, null);
assert.equal(entryContext.viewedPostArticle, null);
assert.equal(entryContext.viewedPostLoading, false);
assert.equal(entryContext.viewedPostToken, 8);
assert.deepEqual(calls, ['home', 'open', 'scan', 'render']);
entryContext.routeKind = 'post';
entryContext.activeMode = 'current';
calls.length = 0;
assert.equal(entryContext.openProfileBatch(), false);
assert.equal(entryContext.activeMode, 'current');
assert.deepEqual(calls, []);

const captureStart = source.indexOf("    toggleBtn.addEventListener('click', (event) => {");
const captureEnd = source.indexOf("    toggleBtn.addEventListener('pointerdown'", captureStart);
let captureClick;
Object.assign(entryContext, {
  toggleDragged: true,
  suppressToggleClick: false,
  openFloatingPanel() { return entryContext.openProfileBatch(); },
  toggleBtn: { addEventListener(type, callback, capture) { assert.equal(capture, true); captureClick = callback; } },
});
vm.runInContext(source.slice(captureStart, captureEnd), entryContext);
let prevented = 0;
const event = { preventDefault() { prevented++; }, stopImmediatePropagation() { prevented++; } };
entryContext.routeKind = 'profile';
captureClick(event);
assert.equal(prevented, 2);
assert.deepEqual(calls, [], 'dragging must not open a panel');
entryContext.toggleDragged = false;
captureClick(event);
assert.equal(prevented, 4, 'profile entry bypasses the shared close toggle');
assert.equal(entryContext.activeMode, 'creator');
console.log('profile entry: batch switch, pending resolve cancellation, detail route and drag behavior passed');

