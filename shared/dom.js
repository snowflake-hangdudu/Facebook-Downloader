(function initDom(root, factory) {
  const api = factory();
  root.DownloaderKit = root.DownloaderKit || {};
  root.DownloaderKit.dom = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function domFactory() {
  function clearNode(node) {
    while (node?.firstChild) node.removeChild(node.firstChild);
  }

  function toLines(value) {
    const values = Array.isArray(value) ? value : String(value || '').split(/\n+/);
    return values.map((item) => String(item || '').trim()).filter(Boolean);
  }

  function appendTextElement(parent, tagName, className, text, title) {
    const node = parent.ownerDocument.createElement(tagName);
    if (className) node.className = className;
    node.textContent = String(text ?? '');
    if (title) node.title = String(title);
    parent.appendChild(node);
    return node;
  }

  function fillTextLines(parent, value, options) {
    const opts = options || {};
    clearNode(parent);
    return toLines(value).map((line) => appendTextElement(
      parent,
      opts.tagName || 'p',
      opts.className || '',
      line
    ));
  }

  function safeExternalLink(anchor, value) {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol !== 'https:' && url.protocol !== 'mailto:') throw new Error('Unsupported protocol');
      anchor.href = url.toString();
      anchor.rel = 'noopener noreferrer';
      return true;
    } catch (_) {
      anchor.removeAttribute('href');
      return false;
    }
  }

  return { clearNode, toLines, appendTextElement, fillTextLines, safeExternalLink };
});
