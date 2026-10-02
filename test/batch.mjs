import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../content/content.js', import.meta.url), 'utf8');
const modelContext = vm.createContext({URL, console});
vm.runInContext(readFileSync(new URL('../content/facebook-model.js', import.meta.url), 'utf8'), modelContext);
const Model = modelContext.FacebookDownloaderModel;
const pageOrderContext = vm.createContext({ Set });
const pageOrderStart = source.indexOf('  function mergePageOrder(');
vm.runInContext(source.slice(pageOrderStart, source.indexOf('\n  const RESOURCE_CACHE_KEY', pageOrderStart)), pageOrderContext);
const ordered = (...args) => Array.from(pageOrderContext.mergePageOrder(...args));
assert.deepEqual(ordered([], ['pinned', 'new', 'old']), ['pinned', 'new', 'old']);
assert.deepEqual(ordered(['pinned', 'new', 'old'], ['old', 'older']), ['pinned', 'new', 'old', 'older'], 'scrolling must preserve earlier loaded page order');
assert.deepEqual(ordered(['new', 'old'], ['pinned', 'new']), ['pinned', 'new', 'old'], 'a pinned post is placed exactly where the page shows it');
assert.deepEqual(ordered(['pinned', 'new', 'old'], ['pinned', 'old', 'new']), ['pinned', 'old', 'new'], 'refresh follows page reorder');
assert.deepEqual(Array.from(Model.filterPosts([
  { id: 'pinned', publishTime: '2020-01-01' }, { id: 'new', publishTime: '2026-10-02' },
], { preserveOrder: true }), post => post.id), [], 'posts without media are excluded');
const image = {id:'im',type:'image',imageCandidates:[{url:'https://pbs.twimg.com/media/im.jpg'}]};
const video = {id:'vid',type:'video',videoCandidates:[{url:'https://video.twimg.com/vid.mp4'}]};
const gif = {id:'gif',type:'gif',videoCandidates:[{url:'https://video.twimg.com/gif.mp4'}]};
assert.deepEqual(Array.from(Model.filterPosts([
  { id: 'pinned', publishTime: '2020-01-01', media: [image] }, { id: 'new', publishTime: '2026-10-02', media: [video] },
], { preserveOrder: true }), post => post.id), ['pinned', 'new'], 'profile order must not be replaced by date sorting');
assert.deepEqual(Array.from(Model.filterPosts([
  { id: 'text', publishTime: '2026-10-02', media: [] },
  { id: 'photo', publishTime: '2026-10-02', media: [image] },
], {}), p => p.id), ['photo'], 'text-only posts are excluded');
const posts = [
  {id:'1',shortcode:'1',publishTime:'2026-09-01',author:{username:'alice'},media:[image]},
  {id:'2',shortcode:'2',publishTime:'2026-10-01',author:{username:'alice'},media:[video,{id:'missing',type:'image'}]},
  {id:'3',shortcode:'3',publishTime:'2026-10-02',author:{username:'alice'},media:[gif]},
  {id:'4',publishTime:'2026-10-02',quotedMediaOnly:true,media:[video]},
];
assert.deepEqual(Array.from(Model.filterPosts(posts,{type:'video'}),p=>p.id),['4','2']);
assert.deepEqual(Array.from(Model.filterPosts(posts,{from:'2026-10-01',to:'2026-10-01'}),p=>p.id),['2']);
assert.deepEqual(Array.from(Model.filterPosts(posts,{min:2,max:2}),p=>p.id),['2']);
assert.deepEqual(Array.from(Model.filterPosts(posts,{limit:1}),p=>p.id),['4']);
assert.deepEqual(
  Array.from(Model.filterPosts([
    { id: 'a', publishTime: '2026-10-02', media: [video], timelineIndex: 1 },
    { id: 'b', publishTime: '2026-09-22', media: [image], pinned: true, timelineIndex: 0 },
    { id: 'c', publishTime: '2026-09-29', media: [gif], timelineIndex: 2 },
    { id: 'd', publishTime: '2026-09-28', media: [image] }
  ], {}), p => p.id),
  ['b', 'a', 'c', 'd'],
  'page DOM order first; off-page posts follow by date'
);
assert.equal(Model.folderPrefix({folderLayout:'flat',creatorFolders:true},posts[0]),'');
assert.equal(Model.folderPrefix({folderLayout:'archive'},posts[0]),'Facebook Downloads/@alice/2026-09-01/1/');
assert.ok(!Model.folderPrefix({folderLayout:'archive'},{author:{username:'../bad'},id:'../bad',publishTime:''}).includes('../'));

const queued = [];
// Manual refresh covers the full collected list, beyond the first UI page.
const refreshPosts = Array.from({ length: 65 }, (_, index) => ({ id: String(index), shortcode: String(index), media: [video] }));
const refreshed = [];
const refreshContext = vm.createContext({
  snapshot: { kind: 'profile' }, creatorPreparing: false, creatorKey: 'alice', creatorPrepareToken: 0,
  creatorPosts: new Map(refreshPosts.map(post => [post.id, post])), resourceCacheReady: Promise.resolve(),
  creatorAutoAttempts: new Map(), creatorCategory: () => 'alice:media', renderCreator() {}, scanDomCreatorPosts() {},
  filteredCreatorPosts: () => refreshPosts, visibleCreatorPosts: () => refreshPosts.slice(0, 60),
  unresolvedAutoPosts: () => [],
  loadResourceCache: async () => {}, creatorReady: post => Boolean(post.ready),
  requestResolve(batch) { batch.forEach(post => { refreshed.push(post.shortcode); refreshContext.creatorPosts.get(post.shortcode).ready = true; }); return 1; },
  waitForResolve: async () => {}, resolveCreatorDetail: async () => null,
  setStatus() {}, t: key => key, scheduleCreatorResolve() {},
  pruneTextOnlyCreatorPosts() {},
});
const refreshStart = source.indexOf('  async function refreshCreatorPosts(');
vm.runInContext(source.slice(refreshStart, source.indexOf('  function profileHeaderDetails()', refreshStart)), refreshContext);
await refreshContext.refreshCreatorPosts();
assert.equal(refreshed.length, 65, 'manual refresh must include collected posts beyond the first 60');
assert.equal(refreshContext.creatorPreparing, false, 'refresh state clears when parsing finishes');

const context = vm.createContext({
  creatorFilters:{type:'video'}, creatorPosts:new Map(posts.map(p=>[p.id,p])),selectedPosts:new Set(['2']),
  filteredCreatorPosts:()=>Model.filterPosts(posts,{type:'video'}),
  pickResource:media=>(media.videoCandidates||media.imageCandidates||[])[0],
  enqueueMedia:async(post,items)=>{queued.push({post,items});return {added:items.length};},
  setStatus(){},t:key=>key,
});
vm.runInContext(source.slice(source.indexOf('  function creatorItems('),source.indexOf('  async function scanCreatorTimeline(')),context);
vm.runInContext(source.slice(source.indexOf('  async function enqueueSelectedCreator('),source.indexOf('  const FILENAME_PRESETS')),context);
await context.enqueueSelectedCreator();
assert.equal(queued.length,1);
assert.equal(queued[0].items.length,1);
assert.equal(queued[0].items[0].type,'video');

// Run the actual scrolling loop with an immediately resolved clock. Stable
// pages terminate, and explicit cancellation prevents a second scroll.
let scrolls=0;
const scanContext=vm.createContext({
  creatorScanning:false,creatorScanToken:0,snapshot:{kind:'profile'},location:{href:'https://x.com/alice/media'},
  creatorVisibleLimit:60,creatorFilters:{limit:''},categoryPosts:()=>posts,filteredCreatorPosts:()=>posts,
  scanDomCreatorPosts(){},scheduleCreatorResolve(){},renderCreator(){},
  document:{documentElement:{scrollHeight:1000}},window:{scrollTo(){scrolls++;}},
  setTimeout(callback){callback();},
});
vm.runInContext(source.slice(source.indexOf('  async function scanCreatorTimeline('),source.indexOf('  const creatorAutoAttempts')),scanContext);
await scanContext.scanCreatorTimeline();
assert.equal(scrolls,5);
assert.equal(scanContext.creatorScanning,false);
scrolls=0;
scanContext.window.scrollTo=()=>{scrolls++;scanContext.creatorScanToken++;scanContext.creatorScanning=false;};
await scanContext.scanCreatorTimeline();
assert.equal(scrolls,1);

const threadQueued=[];
const threadContext=vm.createContext({
  threadScanning:false,threadScanToken:0,snapshot:{kind:'post',threadPosts:posts.slice(0,2)},
  location:{href:'https://x.com/alice/status/12345'},document:{documentElement:{scrollHeight:1000}},
  window:{scrollTo(){}},setTimeout(callback){callback();},renderCurrent(){},renderView(){},
  enqueueMedia:async(post,items)=>threadQueued.push({post,items}),setStatus(){},t:key=>key,
});
vm.runInContext(source.slice(source.indexOf('  async function downloadThread('),source.indexOf('  const creatorFilters')),threadContext);
await threadContext.downloadThread();
assert.deepEqual(threadQueued.map(item=>item.post.id),['1','2']);
assert.equal(threadContext.threadScanning,false);
threadQueued.length=0;
threadContext.window.scrollTo=()=>{threadContext.threadScanToken++;threadContext.threadScanning=false;};
await threadContext.downloadThread();
assert.equal(threadQueued.length,0,'stopping the scan never starts downloads');
console.log('batch type/date/count/latest filters, folders, mixed-media enqueue and scan cancellation passed');
