import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBilibiliUrl, normalizeBilibiliUrl as normalizeTaskUrl, readBilibiliVideo, requestBilibiliJson } from '../plugins/bilibili/common.mjs';
import { BilibiliForumAdapter } from '../plugins/bilibili/forum.mjs';
import { selectBilibiliStreams } from '../plugins/bilibili/provider.mjs';

const bvid = 'BV1xx411c7mD';
const secondBvid = 'BV1sx411c7sB';
const collectionUrl = 'https://space.bilibili.com/2/lists/123?type=season';
const videoUrl = `https://www.bilibili.com/video/${bvid}`;

function response(data, code = 0, status = 200) {
  return { json: async () => ({ code, data, message: code ? '访问受限' : 'OK' }),
    status: () => status, ok: () => status === 200, dispose: async () => {} };
}

function video(id = bvid, pages = [{ page: 1, cid: 101, part: '第一期' }]) {
  return { bvid: id, title: id === bvid ? '测试视频' : '新增视频', owner: { mid: 2, name: 'UP 主' }, pages };
}

function pageFor(context, finalUrl = videoUrl) {
  return { goto: async () => {}, url: () => finalUrl, context: () => context, close: async () => {} };
}

test('Bilibili URL parsing accepts video, short and collection links and rejects unrelated pages', () => {
  assert.deepEqual(parseBilibiliUrl(`${videoUrl}?p=2&spm_id_from=share`), { type: 'video', bvid, part: 2 });
  assert.deepEqual(parseBilibiliUrl('https://m.bilibili.com/video/av42'), { type: 'video', aid: '42', part: 1 });
  assert.equal(parseBilibiliUrl('https://b23.tv/abc123').type, 'short');
  assert.deepEqual(parseBilibiliUrl(collectionUrl), { type: 'collection', mid: '2', seasonId: '123' });
  for (const url of [
    'https://space.bilibili.com/2/channel/collectiondetail?sid=123',
    'https://space.bilibili.com/2/favlist?fid=123&ftype=collect'
  ]) assert.equal(normalizeTaskUrl(url), collectionUrl);
  assert.equal(normalizeTaskUrl(`${videoUrl}/?spm_id_from=share`), `${videoUrl}?p=1`);
  assert.equal(normalizeTaskUrl(`${videoUrl}?p=2`), `${videoUrl}?p=2`);
  assert.deepEqual(parseBilibiliUrl(`${videoUrl}?p=all`), { type: 'video', bvid, part: 'all' });
  assert.equal(normalizeTaskUrl(`${videoUrl}/?p=all&spm_id_from=share`), `${videoUrl}?p=all`);
  assert.equal(normalizeTaskUrl('https://www.bilibili.com/video/BV1wM4y1g7Lp/?spm_id_from=333.337.search-card.all.click&vd_source=c716c136f18def9806b50930ca8079c9'),
    'https://www.bilibili.com/video/BV1wM4y1g7Lp?p=1');
  for (const url of ['https://bilibili.com', 'https://evilbilibili.com/video/av42',
    `${videoUrl}?p=0`, `${videoUrl}?p=-1`, `${videoUrl}?p=1.5`, `${videoUrl}?p=x`,
    'https://space.bilibili.com/2/lists/123?type=series', 'https://www.bilibili.com/bangumi/play/ep1']) {
    assert.equal(parseBilibiliUrl(url), null, url);
  }
});

test('Bilibili single video selects the requested P and resolves short links', async () => {
  const context = { request: { get: async () => response(video(bvid, [
    { page: 1, cid: 101 }, { page: 2, cid: 102, part: '第二期' }
  ])) } };
  const adapter = new BilibiliForumAdapter();
  const page = pageFor(context, `${videoUrl}?p=2`);
  const state = await adapter.inspect(page, 'https://b23.tv/abc123');
  const resources = await adapter.extractResources(page, state.source);
  assert.equal(resources.length, 1);
  assert.equal(resources[0].cid, 102);
  assert.equal(resources[0].url, `${videoUrl}?p=2`);
  assert.equal(resources[0].preserveCompletion, true);
  assert.equal(resources[0].filename, '第二期.mp4');
  await assert.rejects(() => adapter.inspect(page, `${videoUrl}?p=3`), /不存在第 3 P/);
  await assert.rejects(() => adapter.inspect(pageFor(context, 'https://example.com'), 'https://b23.tv/abc123'), /短链未跳转/);
});

test('Bilibili collection follows pagination, deduplicates videos and expands every P', async () => {
  const calls = [];
  const context = { request: { get: async (url, { params }) => {
    calls.push({ url, params });
    if (url.includes('seasons_archives_list')) return response({
      meta: { name: '测试合集' }, page: { total: 31 },
      archives: params.page_num === 1 ? [{ bvid }, { bvid }] : [{ bvid }, { bvid: secondBvid }]
    });
    return response(video(params.bvid, params.bvid === bvid
      ? [{ page: 1, cid: 101 }, { page: 2, cid: 102 }] : undefined));
  } } };
  const adapter = new BilibiliForumAdapter();
  const page = pageFor(context);
  const state = await adapter.inspect(page, collectionUrl);
  const resources = await adapter.extractResources(page, state.source);
  assert.equal(state.source.threadTitle, '测试合集');
  assert.deepEqual(resources.map((item) => item.cid), [101, 102, 101]);
  assert.deepEqual(resources.map((item) => item.filename), [
    '001 - 测试视频.mp4', '001 - 测试视频.mp4', '002 - 新增视频.mp4'
  ]);
  assert.equal(calls.filter((call) => call.url.includes('/view')).length, 2);
  assert.deepEqual(calls.filter((call) => call.url.includes('seasons_archives_list'))
    .map((call) => call.params.page_num), [1, 1, 2]);
});

test('Bilibili collection preserves inaccessible items and rejects non-advancing pages', async () => {
  let total = 2;
  const context = { request: { get: async (url, { params }) => {
    if (url.includes('seasons_archives_list')) return response({ meta: { name: '合集' },
      page: { total }, archives: [{ bvid }, { bvid: secondBvid }] });
    return params.bvid === bvid ? response(null, -404) : response(video(secondBvid));
  } } };
  const adapter = new BilibiliForumAdapter();
  const page = pageFor(context);
  const { source } = await adapter.inspect(page, collectionUrl);
  const items = await adapter.extractResources(page, source);
  assert.match(items[0].inspectionError, /-404/);
  assert.equal(items[1].bvid, secondBvid);
  total = 100;
  await assert.rejects(() => adapter.extractResources(page, source), /分页未前进/);
});

test('Bilibili API calls use the shared browser request session and dispose error responses', async () => {
  let disposed = false;
  const context = { request: { get: async (_url, options) => {
    assert.equal(options.headers.Referer, 'https://www.bilibili.com/');
    return { ...response(null, -101), dispose: async () => { disposed = true; } };
  } } };
  await assert.rejects(() => requestBilibiliJson(context, '/test', {}), /检查登录/);
  assert.equal(disposed, true);
});

test('Bilibili video metadata uses the matching rendered page without calling the rejected view API', async () => {
  const context = { pages: () => [{ url: () => videoUrl, evaluate: async () => video() }],
    request: { get: async () => { assert.fail('rendered metadata should avoid the view API'); } } };
  assert.equal((await readBilibiliVideo(context, { bvid })).bvid, bvid);
});

test('Bilibili HTTP 412 falls back to a video page and rejects stale or missing metadata', async () => {
  let metadata = video();
  let closed = 0;
  let navigated = 0;
  const context = {
    pages: () => [{ url: () => videoUrl, evaluate: async (_callback, args) => args
      ? { status: 412, payload: null } : video(secondBvid) }],
    request: { get: async () => ({ ...response(null, 412, 412), json: async () => null }) },
    newPage: async () => ({
      goto: async (url) => { assert.equal(url, `${videoUrl}/`); navigated += 1; },
      evaluate: async () => metadata,
      close: async () => { closed += 1; }
    })
  };
  assert.equal((await readBilibiliVideo(context, { bvid })).bvid, bvid);
  metadata = video(secondBvid);
  await assert.rejects(() => readBilibiliVideo(context, { bvid }), /HTTP 412/);
  metadata = null;
  await assert.rejects(() => readBilibiliVideo(context, { bvid }), /HTTP 412/);
  assert.equal(navigated, 3);
  assert.equal(closed, 3);
  const controller = new AbortController();
  controller.abort(new Error('cancel-test'));
  await assert.rejects(() => readBilibiliVideo(context, { bvid }, { signal: controller.signal }), /cancel-test/);
  assert.equal(navigated, 3);
});

test('Bilibili API uses Chrome page requests when the download browser has an open Bilibili page', async () => {
  const context = { pages: () => [{ url: () => videoUrl, evaluate: async (_callback, args) => {
    assert.equal(args.pathname, '/x/web-interface/view');
    assert.deepEqual(args.params, { bvid });
    return { status: 200, payload: { code: 0, data: video() } };
  } }] };
  assert.equal((await requestBilibiliJson(context, '/x/web-interface/view', { bvid })).bvid, bvid);
});

test('Bilibili stream selection prefers highest quality, then AVC, and highest audio bitrate', () => {
  const streams = selectBilibiliStreams({ dash: { video: [
    { id: 64, codecid: 7, base_url: 'low' },
    { id: 80, codecid: 12, baseUrl: 'hevc' },
    { id: 80, codecid: 7, baseUrl: 'avc' }
  ], audio: [{ id: 30216, bandwidth: 64, base_url: 'low-audio' },
    { id: 30280, bandwidth: 320, base_url: 'high-audio' }] } });
  assert.equal(streams.video.baseUrl, 'avc');
  assert.equal(streams.audio.id, 30280);
  assert.equal(selectBilibiliStreams({ dash: { video: [{ id: 32, base_url: 'silent' }] } }).audio, null);
  assert.deepEqual(selectBilibiliStreams({ durl: [{ order: 2, url: 'two' }, { order: 1, url: 'one' }] })
    .segments.map((item) => item.url), ['one', 'two']);
  assert.throws(() => selectBilibiliStreams({ dash: { video: [] } }), /未返回/);
  assert.throws(() => selectBilibiliStreams({ is_drm: true }), /DRM/);
});

