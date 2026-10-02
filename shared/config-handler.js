(function initConfigHandler(root) {
  root.DownloaderKit = root.DownloaderKit || {};
  root.DownloaderKit.attachConfigHandler = function attachConfigHandler(ext, options) {
    const remote = root.DownloaderKit.remote;
    if (!remote) throw new Error('DownloaderKit.remote is required');
    const api = ext || root.DownloaderKit.runtime.getApi();
    const handler = remote.createConfigMessageHandler(options);
    api.runtime.onMessage.addListener(handler);
    return handler;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
