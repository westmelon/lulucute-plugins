export const BILIBILI_HEADERS = {
  Referer: 'https://www.bilibili.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
};

export function parseBilibiliUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
  if (url.hostname === 'b23.tv' && /^\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
    return { type: 'short', url: url.toString() };
  }
  if (['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname)) {
    const video = url.pathname.match(/^\/video\/(BV[A-Za-z0-9]{10}|av[1-9]\d*)\/?$/i);
    if (video) {
      const part = url.searchParams.get('p') || '1';
      if (part !== 'all' && (!/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(Number(part)))) return null;
      const id = video[1];
      return { type: 'video', ...(/^av/i.test(id)
        ? { aid: id.slice(2) } : { bvid: `BV${id.slice(2)}` }), part: part === 'all' ? 'all' : Number(part) };
    }
  }
  if (url.hostname === 'space.bilibili.com') {
    const lists = url.pathname.match(/^\/([1-9]\d*)\/lists\/([1-9]\d*)\/?$/);
    if (lists && url.searchParams.get('type') === 'season') {
      return { type: 'collection', mid: lists[1], seasonId: lists[2] };
    }
    const legacy = url.pathname.match(/^\/([1-9]\d*)\/(channel\/collectiondetail|favlist)\/?$/);
    const seasonId = legacy?.[2] === 'favlist' ? url.searchParams.get('fid') : url.searchParams.get('sid');
    if (legacy && /^[1-9]\d*$/.test(seasonId || '')
      && (legacy[2] !== 'favlist' || url.searchParams.get('ftype') === 'collect')) {
      return { type: 'collection', mid: legacy[1], seasonId };
    }
  }
  return null;
}

export function bilibiliCollectionUrl({ mid, seasonId }) {
  return `https://space.bilibili.com/${mid}/lists/${seasonId}?type=season`;
}

export function normalizeBilibiliUrl(value) {
  const parsed = parseBilibiliUrl(value);
  if (parsed?.type === 'collection') return bilibiliCollectionUrl(parsed);
  if (parsed?.type === 'video') {
    return `https://www.bilibili.com/video/${parsed.bvid || `av${parsed.aid}`}?p=${parsed.part}`;
  }
  return null;
}

export class BilibiliApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function requestBilibiliJson(context, pathname, params, { signal } = {}) {
  signal?.throwIfAborted();
  const page = context.pages?.().find((candidate) => {
    try { return ['www.bilibili.com', 'space.bilibili.com', 'm.bilibili.com', 'bilibili.com']
      .includes(new URL(candidate.url()).hostname); } catch { return false; }
  });
  let status;
  let payload;
  if (page) {
    // 使用 Chrome 的网络栈和登录态，与站点页面自身的接口请求一致。
    ({ status, payload } = await page.evaluate(async ({ pathname, params }) => {
      const response = await fetch(`https://api.bilibili.com${pathname}?${new URLSearchParams(params)}`, {
        credentials: 'include', signal: AbortSignal.timeout(30_000)
      });
      return { status: response.status, payload: await response.json().catch(() => null) };
    }, { pathname, params }));
  } else {
    const response = await context.request.get(`https://api.bilibili.com${pathname}`, {
      params, headers: BILIBILI_HEADERS, timeout: 30_000
    });
    try {
      status = response.status();
      payload = await response.json().catch(() => null);
    } finally {
      await response.dispose();
    }
  }
  signal?.throwIfAborted();
  if (status >= 400 || payload?.code !== 0 || !payload.data) {
    const code = payload?.code ?? status;
    const hint = [-101, -403, -352, 401, 403, 412, 62012].includes(code)
      ? '；请在 Chrome 中检查登录、访问权限或风控后重试' : '';
    throw new BilibiliApiError(`Bilibili 请求失败：${payload?.message || `HTTP ${status}`} (${code})${hint}`, code);
  }
  return payload.data;
}

async function readVideoPage(page, identity) {
  const data = await page.evaluate(() => window.__INITIAL_STATE__?.videoData || null);
  const matches = identity.bvid ? data?.bvid === identity.bvid : String(data?.aid) === String(identity.aid);
  return matches && Array.isArray(data.pages) && data.pages.length ? data : null;
}

export async function readBilibiliVideo(context, identity, options = {}) {
  options.signal?.throwIfAborted();
  let data;
  for (const page of context.pages?.() || []) {
    const parsed = parseBilibiliUrl(page.url());
    if (parsed?.type !== 'video' || (identity.bvid
      ? parsed.bvid !== identity.bvid : parsed.aid !== String(identity.aid))) continue;
    data = await readVideoPage(page, identity);
    if (data) break;
  }
  if (!data) {
    try {
      data = await requestBilibiliJson(context, '/x/web-interface/view',
        identity.bvid ? { bvid: identity.bvid } : { aid: identity.aid }, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!(error instanceof BilibiliApiError) || error.code !== 412 || !context.newPage) throw error;
      // view 接口可能被拒绝，但投稿网页仍正常提供服务端渲染的视频信息。
      const page = await context.newPage();
      try {
        await page.goto(`https://www.bilibili.com/video/${identity.bvid || `av${identity.aid}`}/`,
          { waitUntil: 'domcontentloaded' });
        data = await readVideoPage(page, identity);
        if (!data) throw error;
      } finally {
        await page.close();
      }
    }
  }
  options.signal?.throwIfAborted();
  if (!data.bvid || !Array.isArray(data.pages) || !data.pages.length) {
    throw new Error('Bilibili 视频信息缺少 BV 号或分 P 列表');
  }
  if (data.redirect_url?.includes('/bangumi/')) throw new Error('暂不支持番剧，请使用普通投稿或 UP 主合集链接');
  return data;
}
