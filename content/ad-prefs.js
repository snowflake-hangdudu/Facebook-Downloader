// Send the preference before the home timeline requests; do not modify page DOM.
(() => {
  const api = typeof browser !== 'undefined' ? browser : chrome;
  let current;
  const publish = (stored) => {
    current = stored;
    window.postMessage({ source: 'facebook-downloader-content', type: 'AD_SETTINGS', hideAds: stored?.['facebook-dl-settings-v1']?.hideAds !== false }, location.origin);
  };
  window.addEventListener('message', (event) => {
    if (event.source === window && event.origin === location.origin && event.data?.source === 'facebook-downloader-page-agent' && event.data.type === 'AD_SETTINGS_REQUEST' && current) publish(current);
  });
  if (typeof browser !== 'undefined') api.storage.local.get('facebook-dl-settings-v1').then(publish).catch(() => {});
  else api.storage.local.get('facebook-dl-settings-v1', publish);
  api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes['facebook-dl-settings-v1']) publish({ 'facebook-dl-settings-v1': changes['facebook-dl-settings-v1'].newValue }); });
})();
