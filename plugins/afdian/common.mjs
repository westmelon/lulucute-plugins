import { createHash } from 'node:crypto';

const AFDIAN_HOST = /(^|\.)afdian\.(?:com|net)$/i;
const ALBUM_PATH = /^\/album\/([a-f0-9]{32})\/?$/i;
const DYNAMIC_LIST_PATH = /^\/api\/post\/get-list\/?$/i;
const DYNAMIC_FILTERS = [
  'user_id',
  'group_id',
  'all',
  'is_public',
  'plan_id',
  'title',
  'name'
];

export function parseAfdianAlbumId(value) {
  try {
    const url = new URL(value);
    if (!AFDIAN_HOST.test(url.hostname)) return null;
    return url.pathname.match(ALBUM_PATH)?.[1] || null;
  } catch {
    return null;
  }
}

export function parseAfdianDynamicList(value) {
  try {
    const url = new URL(value);
    if (!AFDIAN_HOST.test(url.hostname) || !DYNAMIC_LIST_PATH.test(url.pathname)) return null;
    const userId = url.searchParams.get('user_id');
    if (!/^[a-f0-9]{32}$/i.test(userId || '')) return null;

    const params = { user_id: userId };
    for (const key of DYNAMIC_FILTERS.slice(1)) {
      const filter = url.searchParams.get(key);
      if (filter) params[key] = filter;
    }
    return { userId, params };
  } catch {
    return null;
  }
}

export function normalizeAfdianDynamicListUrl(value) {
  const dynamic = parseAfdianDynamicList(value);
  if (!dynamic) return null;
  const url = new URL('https://afdian.com/api/post/get-list');
  for (const [key, filter] of Object.entries(dynamic.params)) {
    url.searchParams.set(key, filter);
  }
  url.searchParams.sort();
  return url.toString();
}

export function isAfdianCollectionUrl(value) {
  return Boolean(parseAfdianAlbumId(value) || parseAfdianDynamicList(value));
}

export function afdianAttachmentId(attachment) {
  const seed = attachment?.url || `${attachment?.title || ''}\0${attachment?.size || ''}`;
  return createHash('sha256').update(seed).digest('hex');
}

export function afdianPostUrl(albumId, postId) {
  return albumId
    ? `https://afdian.com/album/${albumId}/${postId}`
    : `https://afdian.com/p/${postId}`;
}
