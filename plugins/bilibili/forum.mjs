import {
  bilibiliCollectionUrl,
  parseBilibiliUrl,
  readBilibiliVideo,
  requestBilibiliJson
} from './common.mjs';

const MAX_PAGES = 1_000;

function resourcesForVideo(video, source, { part, rank } = {}) {
  const pages = part === undefined ? video.pages : video.pages.filter((item) => item.page === part);
  if (!pages.length) throw new Error(`Bilibili 视频不存在第 ${part} P`);
  return pages.map((item) => {
    if (!item.cid || !item.page) throw new Error('Bilibili 分 P 信息不完整');
    const name = (video.pages.length > 1 && item.part?.trim()) || video.title || video.bvid;
    return {
      provider: 'bilibili',
      url: `https://www.bilibili.com/video/${video.bvid}?p=${item.page}`,
      bvid: video.bvid,
      cid: item.cid,
      part: item.page,
      filename: `${rank ? `${String(rank).padStart(3, '0')} - ` : ''}${name}.mp4`,
      preserveCompletion: true,
      source
    };
  });
}

function collectionPage(context, collection, pageNumber, options) {
  return requestBilibiliJson(context, '/x/polymer/web-space/seasons_archives_list', {
    mid: collection.mid, season_id: collection.seasonId,
    sort_reverse: 'false', page_num: pageNumber, page_size: 30
  }, options);
}

export class BilibiliForumAdapter {
  match(url) {
    return Boolean(parseBilibiliUrl(url));
  }

  async inspect(page, url, { navigate = true, signal } = {}) {
    let parsed = parseBilibiliUrl(url);
    if (!parsed) throw new Error('不支持的 Bilibili 链接，请使用视频或 UP 主合集链接');
    if (parsed.type === 'short') {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      signal?.throwIfAborted();
      parsed = parseBilibiliUrl(page.url());
      if (!parsed || parsed.type === 'short') throw new Error('Bilibili 短链未跳转到支持的视频或合集');
    } else if (navigate) {
      const navigationUrl = new URL(parsed.type === 'collection' ? bilibiliCollectionUrl(parsed) : url);
      if (parsed.type === 'video' && parsed.part === 'all') navigationUrl.searchParams.set('p', '1');
      await page.goto(navigationUrl.toString(),
        { waitUntil: 'domcontentloaded' });
    }
    const context = page.context();
    if (parsed.type === 'collection') {
      const data = await collectionPage(context, parsed, 1, { signal });
      if (!Array.isArray(data.archives) || !data.meta?.name) throw new Error('Bilibili 合集信息不完整');
      return { locked: false, source: {
        forum: 'Bilibili', section: `UP-${parsed.mid}`, threadId: `season-${parsed.seasonId}`,
        threadTitle: data.meta.name, sourceType: 'collection',
        mid: parsed.mid, seasonId: parsed.seasonId
      } };
    }
    const video = await readBilibiliVideo(context, parsed, { signal });
    const selected = video.pages.find((item) => item.page === parsed.part);
    if (parsed.part !== 'all' && !selected) throw new Error(`Bilibili 视频不存在第 ${parsed.part} P`);
    return { locked: false, source: {
      forum: 'Bilibili', section: video.owner?.name || `UP-${video.owner?.mid || 'unknown'}`,
      threadId: video.bvid, threadTitle: video.title || video.bvid, sourceType: 'video',
      bvid: video.bvid, part: parsed.part
    } };
  }

  async reply() {
    throw new Error('Bilibili 下载不使用公开回复');
  }

  async extractResources(page, source, { signal } = {}) {
    const context = page.context();
    if (source.sourceType === 'video') {
      return resourcesForVideo(await readBilibiliVideo(context, source, { signal }), source,
        { part: source.part === 'all' ? undefined : source.part });
    }
    const resources = [];
    const seen = new Set();
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      const data = await collectionPage(context, source, pageNumber, { signal });
      if (!Array.isArray(data.archives) || !Number.isInteger(data.page?.total) || data.page.total < 0) {
        throw new Error('Bilibili 合集分页信息不完整');
      }
      let added = 0;
      for (const archive of data.archives) {
        if (!archive.bvid || seen.has(archive.bvid)) continue;
        seen.add(archive.bvid);
        added += 1;
        try {
          const video = await readBilibiliVideo(context, archive, { signal });
          resources.push(...resourcesForVideo(video, source, { rank: seen.size }));
        } catch (error) {
          signal?.throwIfAborted();
          // 保留失败条目，让队列报告失败；其余可访问视频仍能完成下载。
          resources.push({ provider: 'bilibili', url: `https://www.bilibili.com/video/${archive.bvid}`,
            inspectionError: error.message, source });
        }
      }
      if (pageNumber * 30 >= data.page.total) return resources;
      if (!added) throw new Error('Bilibili 合集分页未前进，请重试');
    }
    throw new Error(`Bilibili 合集超过 ${MAX_PAGES} 页`);
  }
}
