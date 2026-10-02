(function (root) {
  const kit = root.DownloaderKit = root.DownloaderKit || {};
  const TOKENS = ['title', 'author', 'id', 'index', 'partTitle', 'quality', 'format', 'date'];
  function validate(value) {
    const template = String(value || '').trim();
    if (!template || template.length > 180) throw new Error('文件名模板须为 1–180 个字符');
    if (/[\\/<>:"|?*\x00-\x1f]/.test(template)) throw new Error('文件名模板不能包含路径或非法字符');
    const rest = template.replace(/\{([a-zA-Z]+)\}/g, (_, token) => {
      if (!TOKENS.includes(token)) throw new Error('未知字段：' + token);
      return '';
    });
    if (/[{}]/.test(rest)) throw new Error('字段须写成 {title} 这样的格式');
    return template;
  }
  function filename(template, meta = {}, format = 'mp4') {
    const ext = String(format).toLowerCase();
    if (!/^[a-z0-9]{1,10}$/.test(ext)) throw new Error('无效文件格式');
    const values = { title: '未命名', index: 1, date: new Date().toISOString().slice(0, 10), ...meta, format: ext };
    const base = validate(template).replace(/\{([a-zA-Z]+)\}/g, (_, token) => String(values[token] ?? ''))
      .replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180) || '未命名';
    return (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? '_' : '') + base + '.' + ext;
  }
  function create(options = {}) {
    const runtime = kit.runtime, key = options.storageKey || 'downloadKitSettings_v1';
    let value = { version: 1, filenameTemplate: '{title}' };
    function normalize(raw) {
      try { return { version: 1, filenameTemplate: validate(raw?.filenameTemplate || '{title}') }; }
      catch (_) { return { version: 1, filenameTemplate: '{title}' }; }
    }
    const ready = runtime.storageGet(key).then(stored => { value = normalize(stored[key]); return { ...value }; }).catch(() => ({ ...value }));
    return {
      ready, current: () => ({ ...value }), tokens: TOKENS,
      filename: (meta, format) => filename(value.filenameTemplate, meta, format),
      async save(template) {
        await ready;
        const next = { version: 1, filenameTemplate: validate(template) };
        await runtime.storageSet({ [key]: next }); value = next; return { ...value };
      },
      reset() { return this.save('{title}'); }
    };
  }
  kit.settings = { create, validate, filename, TOKENS };
  if (typeof module === 'object' && module.exports) module.exports = kit.settings;
})(globalThis);
