import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = vm.createContext({
  globalThis: {}, console, URL, Map, Set, WeakSet, Array, Object, String, Number, Date, Math, JSON,
  module: { exports: {} }
});
context.globalThis = context;
vm.runInContext(readFileSync(path.join(root, 'content', 'facebook-model.js'), 'utf8'), context, { filename: 'facebook-model.js' });
const Model = context.FacebookDownloaderModel;

function collect(data) {
  return Model.collectFromJson(data, { posts: new Map(), stories: [], creators: [], seen: new WeakSet(), consumed: new Set(), count: 0 });
}

assert.equal(Model.routeFromUrl('https://www.facebook.com/').kind, 'feed');
assert.equal(Model.routeFromUrl('https://www.facebook.com/watch/').kind, 'feed');
assert.equal(Model.routeFromUrl('https://www.facebook.com/watch/?v=100000000000001').kind, 'post');
assert.equal(Model.routeFromUrl('https://www.facebook.com/watch/?v=100000000000001').shortcode, '100000000000001');
assert.equal(Model.routeFromUrl('https://www.facebook.com/reel/100000000000001').shortcode, '100000000000001');
assert.equal(Model.routeFromUrl('https://www.facebook.com/reels/100000000000001').kind, 'post');
assert.equal(Model.routeFromUrl('https://www.facebook.com/ada').kind, 'profile');
assert.equal(Model.routeFromUrl('https://www.facebook.com/ada/videos').kind, 'profile');
assert.equal(Model.routeFromUrl('https://www.facebook.com/ada/videos/100000000000001').kind, 'post');
assert.equal(Model.routeFromUrl('https://www.facebook.com/ada/posts/pfbid0AAAABBBBCCCC').shortcode, 'pfbid0AAAABBBBCCCC');
assert.equal(Model.routeFromUrl('https://www.facebook.com/marketplace').kind, 'unsupported');
assert.equal(Model.routeFromUrl('https://fb.watch/abcDEF12/').kind, 'post');
assert.equal(Model.profileUrl('99887766'), 'https://www.facebook.com/profile.php?id=99887766');

const video = {
  __typename: 'Video',
  id: '100000000000001',
  browser_native_sd_url: 'https://video.xx.fbcdn.net/v/sd.mp4',
  browser_native_hd_url: 'https://video.xx.fbcdn.net/v/hd.mp4',
  preferred_thumbnail: { image: { uri: 'https://scontent.xx.fbcdn.net/v/thumb.jpg', width: 480, height: 270 } },
  width: 1280,
  height: 720,
  permalink_url: '/reel/100000000000001/',
  owner: { id: '99', name: 'Ada Lovelace', url: 'https://www.facebook.com/ada.lovelace' }
};
const videoBag = collect({ data: { node: video } });
const videoPost = videoBag.posts.get('100000000000001');
assert.ok(videoPost, 'video post is collected');
assert.equal(videoPost.media[0].videoCandidates[0].url, 'https://video.xx.fbcdn.net/v/hd.mp4');
assert.equal(videoPost.author.username, 'ada.lovelace');
assert.equal(videoPost.media[0].posterUrl, 'https://scontent.xx.fbcdn.net/v/thumb.jpg');

const photo = {
  __typename: 'Photo',
  id: '5555555555',
  accessibility_caption: 'A cat on a chair',
  image: { uri: 'https://scontent.xx.fbcdn.net/v/small.jpg', width: 640, height: 640 },
  viewer_image: { uri: 'https://scontent.xx.fbcdn.net/v/large.jpg', width: 2048, height: 2048 },
  owner: { name: 'Ada', url: 'https://www.facebook.com/ada' }
};
const photoPost = collect({ data: photo }).posts.get('5555555555');
assert.equal(photoPost.media[0].type, 'image');
assert.equal(photoPost.media[0].imageCandidates[0].url, 'https://scontent.xx.fbcdn.net/v/large.jpg');
assert.equal(photoPost.title, 'A cat on a chair');

const story = {
  __typename: 'Story',
  url: 'https://www.facebook.com/ada/posts/pfbid0AAAABBBBCCCC',
  message: { text: 'hello world' },
  actors: [{ name: 'Ada', url: 'https://www.facebook.com/ada' }],
  attachments: [{
    media: {
      __typename: 'Video',
      id: '2222222222',
      browser_native_hd_url: 'https://video.xx.fbcdn.net/v/story.mp4',
      width: 1920,
      height: 1080
    }
  }]
};
const storyBag = collect({ data: story });
assert.equal(storyBag.posts.size, 1, 'nested video stays on the story post');
const storyPost = storyBag.posts.get('pfbid0AAAABBBBCCCC');
assert.equal(storyPost.media[0].videoCandidates[0].url, 'https://video.xx.fbcdn.net/v/story.mp4');
assert.equal(storyPost.author.username, 'ada');
assert.equal(Model.snapshotFromCollected(Model.routeFromUrl(story.url), storyBag).post.shortcode, 'pfbid0AAAABBBBCCCC');

const profileBag = collect({
  data: {
    posts: [
      photo,
      { ...video, owner: { name: 'Ada', url: 'https://www.facebook.com/ada' } },
      { ...video, id: '3333333333', permalink_url: '/reel/3333333333/', owner: { name: 'Other', url: 'https://www.facebook.com/other' }, browser_native_hd_url: 'https://video.xx.fbcdn.net/v/other.mp4' }
    ]
  }
});
const profile = Model.snapshotFromCollected(Model.routeFromUrl('https://www.facebook.com/ada'), profileBag);
assert.ok(profile.posts.every((post) => post.author.username === 'ada'));
assert.equal(profile.posts.length, 2);

const album = {
  __typename: 'Story',
  post_id: 'pfbid0AAAABBBBCCCC',
  url: 'https://www.facebook.com/ada/posts/pfbid0AAAABBBBCCCC',
  message: { text: 'two photos' },
  actors: [{ name: 'Ada', url: 'https://www.facebook.com/ada' }],
  attachments: [
    { media: { __typename: 'Photo', id: 'pfbid0AAAABBBBCCCC', image: { uri: 'https://scontent.xx.fbcdn.net/v/a.jpg', width: 526, height: 526 } } },
    { media: { __typename: 'Photo', id: 'pfbid0AAAABBBBCCCC', image: { uri: 'https://scontent.xx.fbcdn.net/v/b.jpg', width: 526, height: 526 } } }
  ]
};
const albumPost = collect({ data: album }).posts.get('pfbid0AAAABBBBCCCC');
assert.equal(albumPost.media.length, 2);
const albumKeys = albumPost.media.map((item) => Model.downloadKey(albumPost.id, item));
assert.equal(new Set(albumKeys).size, 2, 'each selected photo keeps its own count');

const repeatedPhoto = {
  __typename: 'Story',
  post_id: 'pfbid0DUPPHOTO',
  url: 'https://www.facebook.com/ada/posts/pfbid0DUPPHOTO',
  message: { text: 'same photo twice' },
  actors: [{ name: 'Ada', url: 'https://www.facebook.com/ada' }],
  attachments: [{
    media: { __typename: 'Photo', id: 'photo-1', image: { uri: 'https://scontent.xx.fbcdn.net/v/t39.30808-6/111_222_n.jpg?stp=dst-jpg_s960x960', width: 512, height: 640 } },
    styles: { attachment: { media: { __typename: 'Photo', id: 'photo-1', viewer_image: { uri: 'https://scontent.fabc.fbcdn.net/v/t39.30808-6/111_222_o.jpg?_nc_cat=1', width: 512, height: 640 } } } },
    all_subattachments: { nodes: [{ media: { __typename: 'Photo', id: 'photo-1', image: { uri: 'https://scontent.xx.fbcdn.net/v/t39.30808-6/111_222_n.jpg', width: 512, height: 640 } } }] }
  }]
};
const repeated = collect({ data: repeatedPhoto }).posts.get('pfbid0DUPPHOTO');
assert.equal(repeated.media.length, 1, 'the same photo file is not listed twice');
assert.equal(repeated.kind, 'image');
assert.equal(repeated.media[0].width, 512);
assert.equal(repeated.media[0].height, 640);

console.log('facebook routes, video quality, photo size, story grouping and profile filter passed');
