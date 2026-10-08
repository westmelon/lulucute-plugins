import path from 'node:path';
import {
  afdianAttachmentId,
  afdianPostUrl,
  parseAfdianAlbumId,
  parseAfdianDynamicList
} from './common.mjs';

const MAX_PAGES = 1_000;

function extensionFromUrl(value, fallback) {
  try {
    return path.extname(new URL(value).pathname) || fallback;
  } catch {
    return fallback;
  }
}

function resourceUrl(postUrl, mediaType, id = null) {
  const url = new URL(postUrl);
  url.searchParams.set('resource', mediaType);
  if (id) url.searchParams.set('id', id);
  return url.toString();
}

function resourceIdentity(post, source, mediaType, id = null) {
  const canonical = resourceUrl(afdianPostUrl(source.albumId, post.post_id), mediaType, id);
  const albumIds = new Set(post.album_ids || []);
  if (source.albumId) albumIds.add(source.albumId);
  const aliases = [
    resourceUrl(afdianPostUrl(null, post.post_id), mediaType, id),
    ...[...albumIds].map((albumId) =>
      resourceUrl(afdianPostUrl(albumId, post.post_id), mediaType, id))
  ].filter((value, index, all) => value !== canonical && all.indexOf(value) === index);
  return aliases.length > 0 ? { url: canonical, aliasUrls: aliases } : { url: canonical };
}

function rankedFilename(post, source, filename) {
  if (source.sourceType === 'dynamic') {
    const published = new Date(Number(post.publish_time) * 1_000);
    const prefix = Number.isNaN(published.getTime())
      ? String(post.publish_sn || '')
      : published.toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
    return `${prefix} - ${filename}`;
  }
  const width = Math.max(2, String(source.postCount || '').length);
  const rank = String(post.rank || post.publish_sn || '').padStart(width, '0');
  return `${rank} - ${filename}`;
}

export function buildAfdianResources(posts, source) {
  const resources = [];
  for (const post of posts) {
    const postUrl = afdianPostUrl(source.albumId, post.post_id);
    const base = {
      provider: 'afdian',
      postId: post.post_id,
      postUrl,
      preserveCompletion: true,
      source
    };
    if (source.albumId) base.albumId = source.albumId;

    if (post.has_video || post.video) {
      resources.push({
        ...base,
        mediaType: 'video',
        ...resourceIdentity(post, source, 'video'),
        filename: rankedFilename(
          post,
          source,
          `${post.title}${extensionFromUrl(post.video, '.mp4')}`
        )
      });
    }
    if (post.has_audio || post.audio) {
      resources.push({
        ...base,
        mediaType: 'audio',
        ...resourceIdentity(post, source, 'audio'),
        filename: rankedFilename(
          post,
          source,
          `${post.title}${extensionFromUrl(post.audio, '.mp3')}`
        )
      });
    }
    for (const attachment of post.attachment || []) {
      const attachmentId = afdianAttachmentId(attachment);
      resources.push({
        ...base,
        mediaType: 'attachment',
        attachmentId,
        ...resourceIdentity(post, source, 'attachment', attachmentId),
        filename: rankedFilename(post, source, attachment.title || 'attachment')
      });
    }
  }
  return resources;
}

async function requestJson(page, pathname, params) {
  return page.evaluate(async ({ pathname, params }) => {
    const query = new URLSearchParams(params);
    const response = await fetch(`${pathname}?${query}`, { credentials: 'include' });
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  }, { pathname, params });
}

function responseData(result, action) {
  const { status, payload } = result;
  if (payload?.ec === 40100) {
    throw new Error('Afdian login is required; run the one-time --login flow first');
  }
  if (status >= 400 || payload?.ec !== 200) {
    throw new Error(`Afdian ${action} failed: ${payload?.em || `HTTP ${status}`}`);
  }
  return payload.data || {};
}

export class AfdianForumAdapter {
  match(url) {
    return Boolean(parseAfdianAlbumId(url) || parseAfdianDynamicList(url));
  }

  async inspect(page, url, { navigate = true } = {}) {
    const albumId = parseAfdianAlbumId(url);
    const dynamic = parseAfdianDynamicList(url);
    if (!albumId && !dynamic) throw new Error(`Unsupported Afdian collection URL: ${url}`);
    if (navigate) {
      await page.goto(albumId ? url : 'https://afdian.com', { waitUntil: 'domcontentloaded' });
    }

    if (dynamic) {
      const data = responseData(await requestJson(page, '/api/post/get-list', {
        ...dynamic.params,
        type: 'old',
        publish_sn: '',
        per_page: '10'
      }), 'dynamic inspection');
      const first = Array.isArray(data.list) ? data.list[0] : null;
      const planName = first?.unlock_plan?.plan_id === dynamic.params.plan_id
        ? first.unlock_plan.name
        : null;
      return {
        locked: false,
        source: {
          forum: '爱发电',
          section: first?.user?.name || dynamic.userId,
          threadId: dynamic.params.plan_id || `dynamic-${dynamic.userId}`,
          threadTitle: planName || '动态',
          sourceType: 'dynamic',
          userId: dynamic.userId,
          creatorSlug: first?.user?.url_slug || null,
          listParams: dynamic.params,
          postCount: 0
        }
      };
    }

    const data = responseData(
      await requestJson(page, '/api/user/get-album-info', { album_id: albumId }),
      'album inspection'
    );
    const album = data.album;
    if (!album?.album_id) throw new Error('Afdian album information was missing');
    return {
      locked: false,
      source: {
        forum: '爱发电',
        section: album.user?.name || 'unknown',
        threadId: album.album_id,
        threadTitle: album.title || album.album_id,
        sourceType: 'album',
        albumId: album.album_id,
        creatorSlug: album.user?.url_slug || null,
        orderBy: album.order_by || 'rank asc',
        postCount: album.post_count || 0
      }
    };
  }

  async reply() {
    throw new Error('Afdian collections do not use public replies');
  }

  async extractResources(page, source) {
    if (source.sourceType === 'dynamic') {
      const posts = [];
      const seen = new Set();
      let publishSn = '';

      for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
        const data = responseData(await requestJson(page, '/api/post/get-list', {
          ...source.listParams,
          type: 'old',
          publish_sn: publishSn,
          per_page: '10'
        }), 'dynamic listing');
        const list = Array.isArray(data.list) ? data.list : [];
        for (const post of list) {
          if (!post?.post_id || seen.has(post.post_id)) continue;
          seen.add(post.post_id);
          posts.push(post);
        }
        if (!data.has_more) {
          source.postCount = posts.length;
          return buildAfdianResources(posts, source);
        }

        const nextPublishSn = list.at(-1)?.publish_sn;
        if (nextPublishSn === undefined
          || nextPublishSn === null
          || String(nextPublishSn) === String(publishSn)) {
          throw new Error('Afdian dynamic pagination did not advance');
        }
        publishSn = String(nextPublishSn);
      }
      throw new Error(`Afdian dynamic listing exceeded ${MAX_PAGES} pages`);
    }

    const [requestedField, requestedOrder] = String(source.orderBy || '').split(/\s+/);
    const rankField = ['rank', 'publish_sn'].includes(requestedField) ? requestedField : 'rank';
    const rankOrder = ['asc', 'desc'].includes(requestedOrder) ? requestedOrder : 'asc';
    const posts = [];
    const seen = new Set();
    let lastRank = '';

    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const data = responseData(await requestJson(page, '/api/user/get-album-post', {
        album_id: source.albumId,
        lastRank,
        rankOrder,
        rankField
      }), 'album listing');
      const list = Array.isArray(data.list) ? data.list : [];
      for (const post of list) {
        if (!post?.post_id || seen.has(post.post_id)) continue;
        seen.add(post.post_id);
        posts.push(post);
      }
      if (!data.has_more) return buildAfdianResources(posts, source);

      const nextRank = list.at(-1)?.rank;
      if (nextRank === undefined || nextRank === null || String(nextRank) === String(lastRank)) {
        throw new Error('Afdian album pagination did not advance');
      }
      lastRank = String(nextRank);
    }
    throw new Error(`Afdian album exceeded ${MAX_PAGES} pages`);
  }
}
