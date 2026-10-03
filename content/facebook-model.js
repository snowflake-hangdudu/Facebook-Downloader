(function initFacebookDownloaderModel(root) {
  'use strict';

  const STATIC_HINT = /static\.xx\.fbcdn\.net|\/rsrc\.php|emoji\.php|\/images\/emoji|fbcdn\.net\/rsrc\.php/i;
  const AVATAR_HINT = /\/t1\.30497-1\/|\/t39\.30808-1\/|\/t1\.6435-1\/|s(32|40|50|60)x\1|stp=[^&]*s(32|40|50|60)x\2/i;
  const THUMB_HINT = /(?:_s|\/s|p)([1-9]\d{1,2})x\1|stp=[^&]*s([1-9]\d{1,2})x\2/i;
  const RESERVED = /^(?:home|watch|reel|reels|stories|groups|events|marketplace|gaming|pages|friends|messages|notifications|settings|login|recover|privacy|policies|help|ads|business|photo|photos|permalink\.php|profile\.php|share|hashtag|search|saved|memories|bookmarks|live|fundraisers|jobs|dating|places|directory|games|developers|dialog|sharer|plugins|ajax|api|l\.php|story\.php|media|notes|reviews|community|professional_dashboard|latest|favorites|following|followers|about|map|menu|services|home\.php)$/i;
  const PROFILE_TABS = /^(?:photos|photos_by|photos_albums|videos|reels_tab|reels|map|about|reviews|community|followers|following)$/i;
  const SKIP_WALK = new Set(['feedback', 'comments', 'comment_rendering_instance', 'likers', 'reshares', 'seen_by', 'message_threads', 'tracking', 'nt_context', 'extensions', 'debug_info', 'logging', 'client_view_state']);
  const VIDEO_KEYS = [
    ['browser_native_hd_url', 8000000],
    ['playable_url_quality_hd', 7000000],
    ['browser_native_sd_url', 2500000],
    ['playable_url', 1500000]
  ];

  function text(value, limit) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit || 500);
  }

  function httpsUrl(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) return '';
    try {
      const url = new URL(raw, 'https://www.facebook.com/');
      if (url.protocol !== 'https:') return '';
      return url.href;
    } catch (_) {
      return '';
    }
  }

  function hostOf(value) {
    try { return new URL(value).hostname.toLowerCase(); } catch (_) { return ''; }
  }

  function isFacebookHost(host) {
    return /(^|\.)facebook\.com$/i.test(host) || /(^|\.)fb\.watch$/i.test(host);
  }

  function isMediaHost(url) {
    const host = hostOf(url);
    if (!host || isFacebookHost(host)) return false;
    return /(^|\.)(fbcdn\.net|fbcdn\.com|fbsbx\.com)$/i.test(host);
  }

  function isDirectFile(url) {
    return !/\.m3u8(?:$|\?)|\.mpd(?:$|\?)|manifest\.mpd/i.test(String(url || ''));
  }

  function allowedMediaUrl(url) {
    const href = httpsUrl(url);
    return href && isMediaHost(href) && isDirectFile(href) ? href : '';
  }

  function looksLikeAvatar(url) {
    return AVATAR_HINT.test(String(url || ''));
  }

  function looksLikeThumb(url) {
    return THUMB_HINT.test(String(url || ''));
  }

  function usableId(value) {
    const raw = text(value, 160);
    if (/^(?:pfbid[A-Za-z0-9]+|\d{5,20}|\d+_\d+)$/.test(raw)) return raw;
    if (/^[A-Za-z0-9_-]{6,120}$/.test(raw)) return raw;
    return '';
  }

  function shortcodeOf(value) {
    const raw = text(value, 200);
    const direct = usableId(raw);
    if (direct && !/^https?:/i.test(raw)) return direct;
    let url;
    try { url = new URL(String(value || ''), 'https://www.facebook.com/'); } catch (_) { return direct; }
    const host = url.hostname.toLowerCase();
    if (host === 'fb.watch' || host.endsWith('.fb.watch')) {
      return usableId(url.pathname.split('/').filter(Boolean)[0] || '') || direct;
    }
    const queryId = url.searchParams.get('v') || url.searchParams.get('video_id') || url.searchParams.get('fbid') || url.searchParams.get('story_fbid');
    if (usableId(queryId || '')) return usableId(queryId);
    const parts = url.pathname.split('/').filter(Boolean).map((part) => {
      try { return decodeURIComponent(part); } catch (_) { return part; }
    });
    const markers = ['posts', 'videos', 'photos', 'reel', 'reels', 'permalink'];
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (markers.includes(parts[index].toLowerCase()) && usableId(parts[index + 1])) return usableId(parts[index + 1]);
    }
    if (parts[0] === 'share' && usableId(parts[2] || '')) return usableId(parts[2]);
    if (parts[0] === 'stories' && usableId(parts[2] || parts[1] || '')) return usableId(parts[2] || parts[1]);
    return direct;
  }

  function tweetIdOf(value) {
    return shortcodeOf(value);
  }

  function idOf(value) {
    return shortcodeOf(value) || text(value, 160);
  }

  function usernameFromUrl(value) {
    let url;
    try { url = new URL(String(value || ''), 'https://www.facebook.com/'); } catch (_) { return ''; }
    if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return '';
    if (/profile\.php$/i.test(url.pathname)) return text(url.searchParams.get('id'), 80);
    const part = (() => {
      try { return decodeURIComponent(url.pathname.split('/').filter(Boolean)[0] || ''); } catch (_) { return ''; }
    })();
    if (!part || RESERVED.test(part) || part.includes('.')) {
      if (part && !RESERVED.test(part)) return text(part, 80);
      return '';
    }
    return text(part, 80);
  }

  function profileUrl(username) {
    const name = text(username, 80).replace(/^@/, '');
    if (!name) return 'https://www.facebook.com/';
    if (/^\d{5,}$/.test(name)) return 'https://www.facebook.com/profile.php?id=' + encodeURIComponent(name);
    return 'https://www.facebook.com/' + encodeURIComponent(name);
  }

  function permalinkUrl(post) {
    const href = httpsUrl(post?.pageUrl || post?.url || '');
    if (href && isFacebookHost(hostOf(href))) return href;
    const id = shortcodeOf(post?.shortcode || post?.id || '');
    const user = text(post?.author?.username || post?.username, 80).replace(/^@/, '');
    if (!id) return href;
    if (/^pfbid/i.test(id) && user) return profileUrl(user).replace(/\/$/, '') + '/posts/' + id;
    if (user && /^\d+$/.test(id)) return profileUrl(user).replace(/\/$/, '') + '/videos/' + id;
    if (/^\d+$/.test(id)) return 'https://www.facebook.com/watch/?v=' + id;
    return href || ('https://www.facebook.com/' + id);
  }

  function unixTime(value) {
    if (!value) return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
      const ms = value > 1e12 ? value : value * 1000;
      try { return new Date(ms).toISOString(); } catch (_) { return ''; }
    }
    const parsed = Date.parse(String(value));
    if (!Number.isFinite(parsed)) return '';
    try { return new Date(parsed).toISOString(); } catch (_) { return ''; }
  }

  function captionText(value) {
    if (!value) return '';
    if (typeof value === 'string') return String(value).replace(/\r/g, '').trim().slice(0, 2000);
    if (typeof value.text === 'string') return String(value.text).replace(/\r/g, '').trim().slice(0, 2000);
    if (typeof value.message === 'string') return String(value.message).replace(/\r/g, '').trim().slice(0, 2000);
    if (typeof value.message?.text === 'string') return String(value.message.text).replace(/\r/g, '').trim().slice(0, 2000);
    return '';
  }

  function postTitle(caption, id) {
    const line = text(String(caption || '').split(/\r?\n/)[0], 100);
    const cleaned = line.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned || ('Post ' + (id || 'media'));
  }

  function uriOf(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return value.uri || value.url || value.src || '';
    return '';
  }

  function authorFrom(node) {
    const actor = node?.actors?.[0] || node?.owner || node?.author || node?.from || node?.user || node || {};
    const profile = actor.profile_url || actor.url || actor.wwwURL || actor.profileUrl || '';
    const username = usernameFromUrl(profile) || text(actor.username || actor.vanity || '', 80);
    const avatarRaw = uriOf(actor.profile_picture)
      || uriOf(actor.profilePic)
      || uriOf(actor.displayPicture)
      || uriOf(actor.profile_picture_large)
      || uriOf(actor.big_profile_picture)
      || uriOf(actor.profile_picture_depth_0)
      || uriOf(actor.profile_picture_depth_1)
      || actor.profile_picture_url
      || '';
    return {
      id: text(actor.id || actor.user_id || '', 80),
      username,
      displayName: text(actor.name || actor.short_name || username, 120),
      avatar: httpsUrl(avatarRaw)
    };
  }

  function candidate(url, extra) {
    const href = allowedMediaUrl(url);
    if (!href) return null;
    const width = Math.max(0, Number(extra?.width || extra?.w) || 0);
    const height = Math.max(0, Number(extra?.height || extra?.h) || 0);
    return {
      url: href,
      mime: text(extra?.mime || extra?.content_type || extra?.mime_type, 80),
      width,
      height,
      bitrate: Math.max(0, Number(extra?.bitrate) || 0),
      sizeBytes: Math.max(0, Number(extra?.sizeBytes || extra?.size) || 0),
      source: text(extra?.source, 40) || 'structured',
      backupUrls: []
    };
  }

  function dedupeCandidates(list) {
    const seen = new Set();
    const result = [];
    (Array.isArray(list) ? list : []).forEach((item) => {
      if (!item?.url) return;
      const key = item.url.split('#')[0] + '|' + (item.width || 0) + '|' + (item.height || 0) + '|' + (item.bitrate || 0);
      if (seen.has(key)) return;
      seen.add(key);
      result.push(item);
    });
    return result;
  }

  function area(item) {
    return (Number(item?.width) || 0) * (Number(item?.height) || 0);
  }

  function sortImageCandidates(list) {
    return dedupeCandidates(list).sort((a, b) => {
      const aThumb = looksLikeThumb(a.url) || looksLikeAvatar(a.url) ? 1 : 0;
      const bThumb = looksLikeThumb(b.url) || looksLikeAvatar(b.url) ? 1 : 0;
      if (aThumb !== bThumb) return aThumb - bThumb;
      const sourceRank = (item) => item.source === 'structured' ? 3 : item.source === 'srcset' ? 2 : 1;
      if (sourceRank(b) !== sourceRank(a)) return sourceRank(b) - sourceRank(a);
      if (area(b) !== area(a)) return area(b) - area(a);
      return Math.max(b.width, b.height) - Math.max(a.width, a.height);
    });
  }

  function sortVideoCandidates(list) {
    return dedupeCandidates(list).filter((item) => isDirectFile(item.url)).sort((a, b) => {
      if ((b.bitrate || 0) !== (a.bitrate || 0)) return (b.bitrate || 0) - (a.bitrate || 0);
      if (area(b) !== area(a)) return area(b) - area(a);
      return (b.sizeBytes || 0) - (a.sizeBytes || 0);
    });
  }

  function pickBest(list, kind) {
    const sorted = kind === 'video' ? sortVideoCandidates(list) : sortImageCandidates(list);
    if (!sorted.length) return null;
    return { ...sorted[0], backupUrls: sorted.slice(1).map((item) => item.url).filter(Boolean).slice(0, 12) };
  }

  function origImageUrl(url) {
    return allowedMediaUrl(url);
  }

  function sizedImageUrl(url) {
    return allowedMediaUrl(url);
  }

  function videoUrlsFromNode(node) {
    if (!node || typeof node !== 'object') return [];
    const list = [];
    VIDEO_KEYS.forEach(([key, bitrate]) => {
      const item = candidate(node[key], {
        mime: 'video/mp4',
        width: node.original_width || node.width,
        height: node.original_height || node.height,
        bitrate,
        source: 'structured'
      });
      if (item) list.push(item);
    });
    const progressive = node.progressive_urls || node.videoDeliveryLegacyFields?.progressive_urls || [];
    (Array.isArray(progressive) ? progressive : []).forEach((item) => {
      const href = item?.progressive_url || item?.url || item;
      const parsed = candidate(href, {
        mime: 'video/mp4',
        width: item?.width || item?.metadata?.width,
        height: item?.height || item?.metadata?.height,
        bitrate: item?.bitrate || 0,
        source: 'structured'
      });
      if (parsed) list.push(parsed);
    });
    return list;
  }

  function imageFields(node) {
    if (!node || typeof node !== 'object') return [];
    const fields = [
      node.viewer_image,
      node.photo_image,
      node.image,
      node.preferred_thumbnail?.image,
      node.thumbnailImage,
      node.fallback_image,
      node.flexible_height_image,
      node.thumbnail_url
    ];
    const list = [];
    fields.forEach((field) => {
      const uri = typeof field === 'string' ? field : (field?.uri || field?.url);
      const item = candidate(uri, {
        width: field?.width,
        height: field?.height,
        mime: 'image/jpeg',
        source: 'structured'
      });
      if (item && !looksLikeAvatar(item.url) && !STATIC_HINT.test(item.url)) list.push(item);
    });
    return dedupeCandidates(list);
  }

  function isAdNode(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    if (node.sponsored_data || node.ad_id || node.ad_client_token || node.sponsor_relationship) return true;
    const type = String(node.__typename || '');
    if (type === 'SponsoredData' || type === 'Ad' || type === 'SponsoredStory') return true;
    const category = String(node.category || node.feed_unit_category || '');
    return /SPONSORED/i.test(category);
  }

  function nodeId(node) {
    if (!node || typeof node !== 'object') return '';
    const permalink = node.wwwURL || node.url || node.permalink_url || node.story_url || '';
    const fromUrl = shortcodeOf(typeof permalink === 'string' ? permalink : '');
    if (fromUrl) return fromUrl;
    return usableId(node.post_id || node.video_id || node.videoId || node.photo_id || node.id);
  }

  function isStoryNode(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || isAdNode(node)) return false;
    const type = String(node.__typename || '');
    const hasAttachments = Array.isArray(node.attachments) && node.attachments.length > 0;
    if (!(hasAttachments || type === 'Story' || type === 'Post')) return false;
    if (type === 'Video' || type === 'Photo') return false;
    return Boolean(nodeId(node) && (hasAttachments || node.message || node.actors || node.wwwURL || node.url));
  }

  function isDirectPhoto(node) {
    if (!node || typeof node !== 'object' || videoUrlsFromNode(node).length) return false;
    if (String(node.__typename || '') === 'Photo') return imageFields(node).length > 0;
    return Boolean(node.viewer_image?.uri || node.photo_image?.uri);
  }

  function makeMediaItem(kind, index, videos, images, node) {
    const videoList = kind === 'video' ? sortVideoCandidates(videos) : [];
    const imageList = sortImageCandidates(images);
    const bestVideo = videoList[0];
    const bestImage = imageList[0];
    if (kind === 'video' && !bestVideo && !bestImage) return null;
    if (kind !== 'video' && !bestImage) return null;
    const id = usableId(node?.id || node?.video_id || node?.photo_id) || String(index);
    return {
      id,
      index,
      type: kind,
      width: Number(node?.original_width || node?.width || bestVideo?.width || bestImage?.width) || 0,
      height: Number(node?.original_height || node?.height || bestVideo?.height || bestImage?.height) || 0,
      duration: Number(node?.playable_duration_in_ms || node?.length_in_second && node.length_in_second * 1000 || 0) / 1000 || 0,
      posterUrl: bestImage?.url || '',
      mime: kind === 'video' ? 'video/mp4' : (bestImage?.mime || 'image/jpeg'),
      imageCandidates: imageList,
      videoCandidates: videoList,
      fromQuote: false
    };
  }

  function fileKey(url) {
    const href = String(url || '');
    let path = href.split('#')[0].split('?')[0];
    try { path = new URL(href).pathname; } catch (_) {}
    let file = path.split('/').filter(Boolean).pop() || '';
    try { file = decodeURIComponent(file); } catch (_) {}
    return file.toLowerCase().replace(/_(?:n|s|b|o|t|q|p)\.(jpe?g|png|webp|gif)$/i, '.$1');
  }

  function mediaFileKeys(item) {
    const urls = [item?.posterUrl, ...(item?.imageCandidates || []).map((entry) => entry.url), ...(item?.videoCandidates || []).map((entry) => entry.url)];
    return urls.map(fileKey).filter((key) => key.length > 5);
  }

  function dedupeMediaItems(list) {
    const kept = [];
    list.forEach((item) => {
      const keys = mediaFileKeys(item);
      const index = kept.findIndex((other) => keys.some((key) => mediaFileKeys(other).includes(key)));
      if (index < 0) {
        kept.push(item);
        return;
      }
      const other = kept[index];
      const better = ((item.width || 0) * (item.height || 0)) > ((other.width || 0) * (other.height || 0)) ? item : other;
      const worse = better === item ? other : item;
      kept[index] = {
        ...better,
        posterUrl: better.posterUrl || worse.posterUrl,
        width: better.width || worse.width,
        height: better.height || worse.height,
        imageCandidates: sortImageCandidates([...(better.imageCandidates || []), ...(worse.imageCandidates || [])]),
        videoCandidates: sortVideoCandidates([...(better.videoCandidates || []), ...(worse.videoCandidates || [])])
      };
    });
    return kept;
  }

  function gatherMedia(node, into, depth, seen) {
    if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) return;
    seen.add(node);
    const videos = videoUrlsFromNode(node);
    if (videos.length) {
      const item = makeMediaItem('video', into.length + 1, videos, imageFields(node), node);
      if (item) into.push(item);
      return;
    }
    if (isDirectPhoto(node)) {
      const item = makeMediaItem('image', into.length + 1, [], imageFields(node), node);
      if (item) into.push(item);
      return;
    }
    const beforeMedia = Array.isArray(node) ? -1 : into.length;
    if (beforeMedia >= 0 && node.media && typeof node.media === 'object') gatherMedia(node.media, into, depth + 1, seen);
    const tookMedia = beforeMedia >= 0 && into.length > beforeMedia;
    const values = Array.isArray(node) ? node : Object.entries(node)
      .filter(([key]) => !SKIP_WALK.has(key) && key !== 'media' && !(tookMedia && key === 'styles'))
      .map((entry) => entry[1]);
    values.forEach((value) => gatherMedia(value, into, depth + 1, seen));
  }

  function pageKindOf(media) {
    if (media.length > 1) return 'carousel';
    if (media[0]?.type === 'video') return 'video';
    return 'image';
  }

  function makePost(node, extras) {
    if (!node || typeof node !== 'object' || isAdNode(node)) return null;
    const id = nodeId(node) || usableId(extras?.shortcode);
    if (!id) return null;
    const media = [];
    gatherMedia(node, media, 0, new WeakSet());
    const valid = dedupeMediaItems(media.filter((item) => item.videoCandidates.length || item.imageCandidates.length));
    if (!valid.length) return null;
    valid.forEach((item, index) => { item.index = index + 1; });
    const usedIds = new Set();
    valid.forEach((item) => {
      let id = String(item.id || item.index);
      if (usedIds.has(id)) id = id + '-' + item.index;
      usedIds.add(id);
      item.id = id;
    });
    const author = authorFrom(node);
    const username = author.username || extras?.username || '';
    if (username && !author.username) author.username = username;
    const caption = captionText(node.message || node.savable_description || node.title || node.accessibility_caption || node.name || '');
    const pageUrl = permalinkUrl({
      pageUrl: extras?.pageUrl || node.wwwURL || node.url || node.permalink_url,
      shortcode: id,
      author
    });
    return {
      id,
      shortcode: id,
      conversationId: usableId(node.feedback?.id || node.story_id || id),
      quotedMediaOnly: false,
      fromCard: false,
      hasQuote: Boolean(node.attached_story),
      quotedAuthor: { id: '', username: '', displayName: '', avatar: '' },
      quotedMedia: [],
      pageUrl,
      title: postTitle(caption, id),
      caption,
      publishTime: unixTime(node.creation_time || node.publish_time || node.created_time),
      kind: pageKindOf(valid),
      author,
      authors: [author].filter((item) => item.username || item.displayName),
      expectedMediaCount: valid.length,
      media: valid,
      isPartial: false
    };
  }

  function downloadKey(postId, media) {
    const type = media?.type === 'video' || media?.type === 'gif' ? media.type : 'image';
    const index = Number(media?.index) || 1;
    const id = media?.id ? String(media.id) : String(index);
    return [postId || '', id, index, type].join(':');
  }

  function padIndex(index, total) {
    const width = Math.max(2, String(Math.max(1, Number(total) || 1)).length);
    return String(Math.max(1, Number(index) || 1)).padStart(width, '0');
  }

  function templateHasIndex(template) {
    return /\{index\}/i.test(String(template || ''));
  }

  function withAutoIndex(filename, index, total, template) {
    if ((Number(total) || 1) <= 1 || templateHasIndex(template)) return filename;
    const raw = String(filename || '');
    const match = raw.match(/\.([a-z0-9]{1,8})$/i);
    const ext = match ? match[0] : '';
    const base = ext ? raw.slice(0, -ext.length) : raw;
    if (new RegExp('[-_ ]0*' + Number(index) + '$').test(base)) return filename;
    return base.replace(/[. ]+$/g, '') + ' - ' + padIndex(index, total) + ext;
  }

  function folderPrefix(prefs, post) {
    const parts = [];
    if (prefs?.folderLayout === 'flat') return '';
    if (prefs?.folderLayout === 'archive') {
      const safe = (value) => text(value, 80).replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '') || 'unknown';
      return 'Facebook Downloads/@' + safe(post?.author?.username) + '/' +
        safe(String(post?.publishTime || '').slice(0, 10) || 'undated') + '/' + safe(post?.shortcode || post?.id) + '/';
    }
    if (prefs?.creatorFolders && post?.author?.username) parts.push(text(post.author.username, 60));
    if (prefs?.carouselFolders && (post?.media?.length || 0) > 1) parts.push(text(post.shortcode || post.id, 40));
    return parts.length ? ('Facebook Downloads/' + parts.join('/') + '/') : '';
  }

  function scorePost(item) {
    return (item?.media?.length || 0) * 10
      + (item?.media || []).reduce((total, media) => total + (media.videoCandidates?.length || 0) * 3 + (media.imageCandidates?.length || 0), 0);
  }

  function collectFromJson(data, into, extras) {
    const posts = into?.posts || new Map();
    const stories = into?.stories || [];
    const creators = into?.creators || [];
    const seen = into?.seen || new WeakSet();
    const consumed = into?.consumed || new Set();
    const extrasSafe = extras || {};
    let count = extrasSafe.count || 0;
    function store(post) {
      if (!post) return;
      const key = post.shortcode || post.id;
      const previous = posts.get(key);
      if (!previous || scorePost(post) >= scorePost(previous)) posts.set(key, post);
      (post.media || []).forEach((item) => { if (item.id) consumed.add(String(item.id)); });
      if (post.author?.username || post.author?.displayName) creators.push(post.author);
    }
    function walk(node, depth) {
      if (count > 8000 || depth > 24 || !node || typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);
      count += 1;
      if (Array.isArray(node)) {
        node.forEach((item) => walk(item, depth + 1));
        return;
      }
      if (isAdNode(node)) return;
      const id = nodeId(node);
      if (isStoryNode(node)) store(makePost(node, extrasSafe));
      else if (id && !consumed.has(String(id)) && videoUrlsFromNode(node).length) store(makePost(node, extrasSafe));
      else if (id && !consumed.has(String(id)) && isDirectPhoto(node)) store(makePost(node, extrasSafe));
      Object.keys(node).forEach((key) => {
        if (SKIP_WALK.has(key)) return;
        walk(node[key], depth + 1);
      });
    }
    walk(data, 0);
    into.posts = posts;
    into.stories = stories;
    into.creators = creators;
    into.seen = seen;
    into.consumed = consumed;
    into.count = count;
    return into;
  }

  function parseHtmlPayloads(html) {
    const payloads = [];
    const source = String(html || '');
    const pattern = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = pattern.exec(source))) {
      const raw = String(match[1] || '').trim().replace(/^for \(;;\);/, '');
      if (!raw) continue;
      try { payloads.push(JSON.parse(raw)); } catch (_) {}
    }
    return payloads;
  }

  function routeFromUrl(href) {
    let url;
    try { url = new URL(String(href || ''), 'https://www.facebook.com/'); } catch (_) { return { kind: 'unsupported', url: String(href || '') }; }
    const host = url.hostname.toLowerCase();
    if (host === 'fb.watch' || host.endsWith('.fb.watch')) {
      const code = usableId(url.pathname.split('/').filter(Boolean)[0] || '');
      return code ? { kind: 'post', shortcode: code, url: url.href } : { kind: 'unsupported', url: url.href };
    }
    if (!/(^|\.)facebook\.com$/i.test(host)) return { kind: 'unsupported', url: url.href };
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const parts = path.split('/').filter(Boolean).map((part) => {
      try { return decodeURIComponent(part); } catch (_) { return part; }
    });
    const watchId = usableId(url.searchParams.get('v') || url.searchParams.get('video_id') || '');
    if ((parts[0] === 'reel' || parts[0] === 'reels') && usableId(parts[1] || '')) {
      return { kind: 'post', shortcode: usableId(parts[1]), url: url.href };
    }
    if (parts[0] === 'watch' && watchId) return { kind: 'post', shortcode: watchId, url: url.href };
    if (parts[0] === 'watch' || parts[0] === 'reel' || parts[0] === 'reels') return { kind: 'feed', url: url.href };
    const fbid = usableId(url.searchParams.get('fbid') || url.searchParams.get('story_fbid') || '');
    if ((parts[0] === 'photo.php' || parts[0] === 'permalink.php' || parts[0] === 'story.php' || parts[0] === 'photo') && fbid) {
      return { kind: 'post', shortcode: fbid, url: url.href };
    }
    if (parts[0] === 'profile.php') {
      const id = text(url.searchParams.get('id'), 80);
      return id ? { kind: 'profile', username: id, url: url.href } : { kind: 'unsupported', url: url.href };
    }
    if (parts[0] === 'groups' && parts[1]) {
      if ((parts[2] === 'posts' || parts[2] === 'permalink') && usableId(parts[3] || '')) {
        return { kind: 'post', shortcode: usableId(parts[3]), username: parts[1], url: url.href };
      }
      if (parts.length === 2) return { kind: 'profile', username: parts[1], url: url.href };
    }
    if (parts[0] === 'share' && usableId(parts[2] || '')) return { kind: 'post', shortcode: usableId(parts[2]), url: url.href };
    if (parts[0] === 'stories' && parts[1]) return { kind: 'post', shortcode: usableId(parts[2] || parts[1]), url: url.href };
    if (parts.length >= 3 && /^(posts|videos|photos|reel|reels)$/i.test(parts[1]) && usableId(parts[2])) {
      return { kind: 'post', shortcode: usableId(parts[2]), username: parts[0], url: url.href };
    }
    if (parts.length >= 3 && /^photos/i.test(parts[1] || '')) {
      const photoId = [...parts].reverse().find((part) => /^\d{5,20}$/.test(part));
      if (photoId) return { kind: 'post', shortcode: photoId, username: parts[0], url: url.href };
    }
    if (!parts.length || parts[0] === 'home.php') return { kind: 'feed', url: url.href };
    if (RESERVED.test(parts[0])) return { kind: 'unsupported', url: url.href };
    if (parts.length === 1 || (parts.length === 2 && PROFILE_TABS.test(parts[1]))) {
      return { kind: 'profile', username: parts[0], url: url.href };
    }
    return { kind: 'unsupported', url: url.href };
  }

  function snapshotFromCollected(route, collected) {
    const posts = [...(collected.posts || new Map()).values()];
    const creator = route.username
      ? (collected.creators || []).find((item) => item.username?.toLowerCase() === route.username.toLowerCase()) || null
      : collected.creators?.[0] || null;
    if (route.kind === 'post') {
      const post = posts.find((item) => item.shortcode === route.shortcode) || null;
      if (!post) return { kind: 'post', url: route.url, reason: 'unrecognized', post: null, creator, stories: [] };
      const threadPosts = posts.filter((item) => item.conversationId && item.conversationId === post.conversationId &&
        item.author?.username && item.author.username.toLowerCase() === post.author?.username?.toLowerCase());
      return { kind: 'post', url: route.url, post, threadPosts, creator: post.author || creator, stories: [] };
    }
    if (route.kind === 'profile') {
      return {
        kind: 'profile',
        url: route.url,
        creator: creator || { username: route.username, displayName: route.username, id: '', avatar: '' },
        posts: posts.filter((item) => !route.username || !item.author?.username || item.author.username.toLowerCase() === String(route.username || '').toLowerCase()),
        stories: []
      };
    }
    if (route.kind === 'feed') {
      const post = posts[0] || null;
      return { kind: 'feed', url: route.url, post, creator: post?.author || creator, stories: [] };
    }
    return { kind: 'unsupported', url: route.url, reason: 'unsupported', post: null, creator, stories: [] };
  }

  function filterTimelineAds(payload) {
    let removed = 0;
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 24) return;
      if (Array.isArray(node)) {
        for (let index = node.length - 1; index >= 0; index -= 1) {
          const item = node[index];
          if (isAdNode(item) || isAdNode(item?.node)) {
            node.splice(index, 1);
            removed += 1;
          } else visit(item, depth + 1);
        }
        return;
      }
      Object.keys(node).forEach((key) => {
        if (key === 'edges' && Array.isArray(node[key])) {
          node[key] = node[key].filter((item) => {
            if (isAdNode(item) || isAdNode(item?.node)) {
              removed += 1;
              return false;
            }
            return true;
          });
          node[key].forEach((item) => visit(item, depth + 1));
          return;
        }
        visit(node[key], depth + 1);
      });
    };
    visit(payload, 0);
    return removed;
  }

  const api = {
    filterPosts(list, filters = {}) {
      const type = filters.type || 'all';
      const result = list.filter((post) => {
        const count = post.media?.length || 0;
        if (!count) return false;
        const date = String(post.publishTime || '').slice(0, 10);
        return (!filters.from || date && date >= filters.from) && (!filters.to || date && date <= filters.to) &&
          (!filters.min || count >= Number(filters.min)) && (!filters.max || count <= Number(filters.max)) &&
          (type === 'all' || post.media?.some((media) => media.type === type));
      });
      if (!filters.preserveOrder) result.sort((a, b) => {
        const aHas = Number.isFinite(a.timelineIndex);
        const bHas = Number.isFinite(b.timelineIndex);
        if (aHas && bHas && a.timelineIndex !== b.timelineIndex) return a.timelineIndex - b.timelineIndex;
        if (aHas !== bHas) return aHas ? -1 : 1;
        const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
        if (pin) return pin;
        return String(b.publishTime || '').localeCompare(String(a.publishTime || ''))
          || String(b.id || '').localeCompare(String(a.id || ''));
      });
      return filters.limit > 0 ? result.slice(0, Number(filters.limit)) : result;
    },
    filterTimelineAds,
    text,
    httpsUrl,
    allowedMediaUrl,
    isMediaHost,
    looksLikeAvatar,
    looksLikeThumb,
    shortcodeOf,
    tweetIdOf,
    idOf,
    usernameFromUrl,
    profileUrl,
    permalinkUrl,
    captionText,
    postTitle,
    authorFrom,
    pickBest,
    sortImageCandidates,
    sortVideoCandidates,
    makePost,
    makeMediaItem,
    downloadKey,
    padIndex,
    templateHasIndex,
    withAutoIndex,
    folderPrefix,
    uniqueMedia: dedupeMediaItems,
    collectFromJson,
    parseHtmlPayloads,
    routeFromUrl,
    snapshotFromCollected,
    origImageUrl,
    sizedImageUrl,
    STATIC_HINT
  };

  root.FacebookDownloaderModel = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
