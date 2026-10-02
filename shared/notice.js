(function initNotice(root, factory) {
  const api = factory();
  root.DownloaderKit = root.DownloaderKit || {};
  root.DownloaderKit.notice = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function noticeFactory() {
  const DEFAULT_LABELS = {
    pinned: '置顶说明',
    recent: '最近更新',
    knownIssues: '已知问题',
    roadmap: '开发计划',
    feedback: '待反馈需求',
    upcoming: '待更新需求',
    planned: '待做需求',
    empty: '暂无新公告'
  };

  function fillNoticeBody(el, notice, options) {
    const opts = options || {};
    const dom = opts.dom || globalThis.DownloaderKit?.dom;
    if (!el || !dom) return;
    const labels = { ...DEFAULT_LABELS, ...(opts.labels || {}) };
    const prefix = opts.classPrefix || 'dl-kit';
    dom.clearNode(el);

    function section(title, value) {
      const lines = dom.toLines(value);
      if (!lines.length) return;
      const wrap = el.ownerDocument.createElement('div');
      wrap.className = prefix + '-notice-section';
      dom.appendTextElement(wrap, 'div', prefix + '-notice-section-title', title);
      const list = el.ownerDocument.createElement('div');
      list.className = prefix + '-notice-list';
      lines.forEach((line) => dom.appendTextElement(list, 'div', prefix + '-notice-item', line));
      wrap.appendChild(list);
      el.appendChild(wrap);
    }

    const roadmap = notice?.roadmap && typeof notice.roadmap === 'object' ? notice.roadmap : {};
    const hasStructured = ['pinned', 'recent', 'knownIssues'].some((key) => dom.toLines(notice?.[key]).length) ||
      ['feedback', 'upcoming', 'planned'].some((key) => dom.toLines(roadmap[key]).length);
    if (!hasStructured) {
      dom.fillTextLines(el, notice?.body || labels.empty);
      return;
    }

    section(labels.pinned, notice.pinned);
    section(labels.recent, notice.recent);
    section(labels.knownIssues, notice.knownIssues);
    const roadmapRows = [
      [labels.feedback, roadmap.feedback],
      [labels.upcoming, roadmap.upcoming],
      [labels.planned, roadmap.planned]
    ];
    if (roadmapRows.some(([, value]) => dom.toLines(value).length)) {
      const wrap = el.ownerDocument.createElement('div');
      wrap.className = prefix + '-notice-section';
      dom.appendTextElement(wrap, 'div', prefix + '-notice-section-title', labels.roadmap);
      roadmapRows.forEach(([label, value]) => {
        const lines = dom.toLines(value);
        if (!lines.length) return;
        const group = el.ownerDocument.createElement('div');
        group.className = prefix + '-notice-plan';
        dom.appendTextElement(group, 'div', prefix + '-notice-plan-label', label);
        const list = el.ownerDocument.createElement('div');
        list.className = prefix + '-notice-list';
        lines.forEach((line) => dom.appendTextElement(list, 'div', prefix + '-notice-item', line));
        group.appendChild(list);
        wrap.appendChild(group);
      });
      el.appendChild(wrap);
    }
  }

  return { DEFAULT_LABELS, fillNoticeBody };
});
