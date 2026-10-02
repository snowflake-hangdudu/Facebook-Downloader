import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ URL, console });
vm.runInContext(readFileSync(new URL('../content/facebook-model.js', import.meta.url), 'utf8'), context);
const filter = context.FacebookDownloaderModel.filterTimelineAds;

const normal = { node: { __typename: 'Story', post_id: '111_222', message: { text: 'ordinary post' } } };
const sponsored = { node: { __typename: 'Story', post_id: '333_444', sponsored_data: { ad_id: 'ad-1' } } };
const labeled = { category: 'SPONSORED', node: { __typename: 'Story', post_id: '555_666' } };
const payload = { data: { viewer: { news_feed: { edges: [normal, sponsored, labeled] } } } };

assert.equal(filter(payload), 2);
assert.equal(payload.data.viewer.news_feed.edges.length, 1);
assert.equal(payload.data.viewer.news_feed.edges[0], normal);
assert.equal(filter(payload), 0);

const detail = { data: { node: { __typename: 'Story', post_id: '111_222', message: { text: 'This caption mentions a sponsored sale' } } } };
assert.equal(filter(detail), 0, 'ordinary captions must stay on the page');

console.log('facebook sponsored edge filtering and detail isolation passed');
