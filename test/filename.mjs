import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = vm.createContext({ globalThis: {}, console, URL, Map, Set, WeakSet, Array, Object, String, Number, Date, Math, JSON, module: { exports: {} } });
context.globalThis = context;
vm.runInContext(readFileSync(path.join(root, 'content', 'facebook-model.js'), 'utf8'), context, { filename: 'facebook-model.js' });
vm.runInContext(readFileSync(path.join(root, 'shared', 'settings.js'), 'utf8'), context, { filename: 'settings.js' });
const Model = context.FacebookDownloaderModel;
const settings = context.DownloaderKit.settings;

assert.equal(Model.withAutoIndex('emoji 😀 - user.jpg', 1, 2, '{title} - {author}'), 'emoji 😀 - user - 01.jpg');
assert.equal(Model.withAutoIndex('中文标题 - 作者.jpg', 2, 2, '{title} - {author}'), '中文标题 - 作者 - 02.jpg');
const long = 'a'.repeat(120);
assert.ok(Model.postTitle(long, 'ID').length <= 100);
assert.equal(Model.postTitle('a/b:c*d?.jpg', 'ID').includes('/'), false);
assert.equal(Model.postTitle('', 'ZZ99'), 'Post ZZ99');
assert.equal(Model.withAutoIndex('Title - author - 03.jpg', 3, 12, '{title} - {author} - {index}'), 'Title - author - 03.jpg');
assert.equal(Model.padIndex(3, 120), '003');

const name = settings.filename('{title} - {author}', { title: 'Hello', author: 'alice', index: 1 }, 'jpg');
assert.equal(name, 'Hello - alice.jpg');
const withIndex = settings.filename('{title} - {author} - {index}', { title: 'Hello', author: 'alice', index: 2 }, 'jpg');
assert.equal(withIndex, 'Hello - alice - 2.jpg');

console.log('filename auto-index, illegal characters, empty title and kit tokens passed');
