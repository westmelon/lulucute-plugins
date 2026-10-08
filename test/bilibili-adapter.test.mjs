import { coreModule } from './helpers/core.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { BilibiliProviderAdapter } from '../plugins/bilibili/provider.mjs';
const { TaskQueue } = await coreModule('src/core/task-queue.mjs');
const { createWorkflow } = await coreModule('src/app-runtime.mjs');
const { runQueuedTasks } = await coreModule('src/core/batch-runner.mjs');
const { Aria2Downloader } = await coreModule('src/core/aria2-downloader.mjs');

import { testPlugins } from './helpers/plugins.mjs';
const { pluginServices } = await coreModule('src/core/plugin-loader.mjs');

const run = promisify(execFile);
const ffmpegPath = process.env.BILIBILI_TEST_FFMPEG || 'ffmpeg';
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

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bilibili-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('Bilibili missing FFmpeg requests action before fetching or downloading media', async (t) => {
  const root = await temporaryDirectory(t);
  const provider = new BilibiliProviderAdapter({ services: pluginServices, ffmpegPath: path.join(root, 'missing-ffmpeg') });
  const result = await provider.resolve({}, { provider: 'bilibili', url: videoUrl }, { directory: root });
  assert.equal(result.status, 'action-required');
  assert.equal(result.reason, 'bilibili-ffmpeg-missing');
  assert.deepEqual(await readdir(root), []);
  const invalid = new BilibiliProviderAdapter({ services: pluginServices, ffmpegPath: process.execPath });
  const unavailable = await invalid.resolve({}, { provider: 'bilibili', url: videoUrl }, { directory: root });
  assert.equal(unavailable.reason, 'bilibili-ffmpeg-unavailable');
});

test('Bilibili missing aria2 requests action before accessing the API', async (t) => {
  const root = await temporaryDirectory(t);
  const provider = new BilibiliProviderAdapter({ services: pluginServices, ffmpegPath, aria2Path: path.join(root, 'missing-aria2') });
  const result = await provider.resolve({ request: { get: async () => assert.fail('API must not be called') } },
    { provider: 'bilibili', bvid, cid: 101 }, { directory: root });
  assert.equal(result.status, 'action-required');
  assert.equal(result.reason, 'bilibili-aria2-missing');
  assert.deepEqual(await readdir(root), []);
});

test('Bilibili streams use aria2 mirrors, mux real MP4 and retain failed media for retry', async (t) => {
  try { await run(ffmpegPath, ['-version']); } catch {
    t.skip('FFmpeg is unavailable; set BILIBILI_TEST_FFMPEG to a working executable');
    return;
  }
  const root = await temporaryDirectory(t);
  const fixtures = path.join(root, 'fixtures');
  await mkdir(fixtures);
  const videoPath = path.join(fixtures, 'video.mp4');
  const audioPath = path.join(fixtures, 'audio.m4a');
  await run(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=0.5',
    '-c:v', 'libx264', '-an', videoPath]);
  await run(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
    '-c:a', 'aac', audioPath]);
  const buffers = { '/video': await readFile(videoPath), '/audio': await readFile(audioPath) };
  const server = createServer((req, res) => {
    assert.equal(req.headers.referer, 'https://www.bilibili.com/');
    assert.equal(req.headers.cookie, undefined);
    if (req.url === '/stalled') { res.writeHead(200); res.write('partial'); return; }
    if (!buffers[req.url]) { res.writeHead(403).end(); return; }
    res.end(buffers[req.url]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const data = { quality: 80, dash: {
    video: [{ id: 80, codecid: 7, base_url: `${origin}/stalled`,
      backup_url: [`${origin}/denied`, `${origin}/video`] }],
    audio: [{ id: 30280, baseUrl: `${origin}/audio` }]
  } };
  const context = { request: { get: async (_url, options) => {
    assert.equal(options.params.cid, 101);
    return response(data);
  } } };
  const directory = path.join(root, 'output');
  const resource = { provider: 'bilibili', bvid, cid: 101, url: `${videoUrl}?p=1`, filename: '测试.mp4' };
  const provider = new BilibiliProviderAdapter({ services: pluginServices, ffmpegPath, downloader: new Aria2Downloader({
    executable: process.env.BILIBILI_TEST_ARIA2 || 'aria2c', pollIntervalMs: 100, timeoutSeconds: 1
  }) });
  const progress = [];
  const first = await provider.resolve(context, resource,
    { directory, onProgress: async (value) => progress.push(value) });
  assert.equal(first.status, 'downloaded');
  assert.ok(progress.some((value) => value.streamName === '视频' && value.bytes > 0));
  assert.ok(progress.some((value) => value.streamName === '音频' && value.bytes > 0));
  assert.equal(progress.at(-1).streamName, '合并中');
  const info = await run(ffmpegPath, ['-hide_banner', '-i', first.download.path, '-f', 'null', '-']);
  assert.match(info.stderr, /Video: h264/);
  assert.match(info.stderr, /Audio: aac/);
  const original = await readFile(first.download.path);
  const unsafeName = await provider.resolve(context, { ...resource, filename: '001 - A/B.mp4' }, { directory });
  assert.equal(path.basename(unsafeName.download.path), '001 - A_B.mp4');
  const next = await provider.resolve(context, resource, { directory });
  assert.notEqual(first.download.path, next.download.path);
  assert.deepEqual(await readFile(first.download.path), original);
  const segmentPath = path.join(fixtures, 'segment.flv');
  await run(ffmpegPath, ['-v', 'error', '-i', first.download.path, '-c', 'copy', '-f', 'flv', segmentPath]);
  buffers['/segment'] = await readFile(segmentPath);
  const segments = await provider.resolve({ request: { get: async () => response({ durl: [
    { order: 2, url: `${origin}/segment` }, { order: 1, url: `${origin}/segment` }
  ] }) } }, resource, { directory });
  const concatInfo = await run(ffmpegPath, ['-hide_banner', '-i', segments.download.path, '-f', 'null', '-']);
  assert.match(concatInfo.stderr, /Video: h264/);
  assert.match(concatInfo.stderr, /Audio: aac/);
  const controller = new AbortController();
  const cancelling = new BilibiliProviderAdapter({ services: pluginServices, ffmpegPath, downloader: { download: async ({ signal }) => {
    controller.abort(new Error('cancel-test'));
    signal.throwIfAborted();
  } } });
  await assert.rejects(() => cancelling.resolve(context, resource, { directory, signal: controller.signal }), /cancel-test/);
  const failing = new BilibiliProviderAdapter({ services: pluginServices, ffmpegPath, downloader: { download: async ({ directory: temp, filename }) => {
    const target = path.join(temp, filename);
    await writeFile(target, 'corrupt-media');
    return { path: target };
  } } });
  await assert.rejects(() => failing.resolve(context, resource, { directory }), /FFmpeg 合并失败/);
  const retained = (await readdir(directory)).filter((name) => name.startsWith('.bilibili-'));
  assert.equal(retained.length, 1);
  assert.equal(await readFile(path.join(directory, retained[0], 'video.m4s'), 'utf8'), 'corrupt-media');
  assert.equal((await readdir(path.join(directory, retained[0]))).includes('output.mp4'), false);
});

test('Bilibili collection queue incrementally downloads new videos and shares completion with single-video tasks', async (t) => {
  const root = await temporaryDirectory(t);
  const queue = await new TaskQueue(path.join(root, 'tasks.json'), testPlugins).open();
  t.after(() => queue.close());
  let archives = [{ bvid }];
  const context = { request: { get: async (url, { params }) =>
    response(url.includes('seasons_archives_list')
      ? { meta: { name: '测试合集' }, page: { total: archives.length }, archives }
      : video(params.bvid)) } };
  context.newPage = async () => pageFor(context);
  const downloads = [];
  const workflow = createWorkflow({ downloadRoot: root, workflow: {} }, { ...testPlugins, providers: [{
    match: (resource) => resource.provider === 'bilibili',
    resolve: async (_context, resource) => {
      downloads.push(resource.bvid);
      return { status: 'downloaded', resource, download: { path: '/test.mp4' } };
    }
  }] });
  await queue.enqueue([collectionUrl]);
  await runQueuedTasks({ queue, workflow, context, log: () => {} });
  archives = [{ bvid }, { bvid: secondBvid }];
  const requeued = await queue.enqueue([collectionUrl]);
  assert.equal(requeued.refreshed.length, 1);
  const processed = await runQueuedTasks({ queue, workflow, context, log: () => {} });
  assert.deepEqual(downloads, [bvid, secondBvid]);
  assert.equal(processed[0].summary.skipped, 1);
  await queue.enqueue([videoUrl]);
  const single = await runQueuedTasks({ queue, workflow, context, log: () => {} });
  assert.equal(single[0].summary.skipped, 1);
  assert.deepEqual(downloads, [bvid, secondBvid]);
});

test('Bilibili all P uses one task and retries failed parts while sharing single-P completion', async (t) => {
  const root = await temporaryDirectory(t);
  const queue = await new TaskQueue(path.join(root, 'tasks.json'), testPlugins).open();
  t.after(() => queue.close());
  const pages = [1, 2, 3].map((part) => ({ page: part, cid: 100 + part, part: `第${part}期` }));
  const context = { request: { get: async () => response(video(bvid, pages)) } };
  const navigations = [];
  context.newPage = async () => ({ ...pageFor(context), goto: async (url) => navigations.push(url) });
  const calls = [];
  let failSecondPart = true;
  const workflow = createWorkflow({ downloadRoot: root, workflow: {} }, { ...testPlugins, providers: [{
    match: (resource) => resource.provider === 'bilibili',
    resolve: async (_context, resource) => {
      calls.push(resource.part);
      if (resource.part === 2 && failSecondPart) throw new Error('CDN disconnected');
      return { status: 'downloaded', resource, download: { path: '/fixture.mp4' } };
    }
  }] });
  const { added: [single] } = await queue.enqueue([videoUrl]);
  await runQueuedTasks({ queue, workflow, context, log: () => {} });
  await queue.remove(single.id);
  const { added: [all], existing } = await queue.enqueue([
    `${videoUrl}?p=all`, `${videoUrl}/?spm_id_from=share&p=all`
  ]);
  assert.equal(existing.length, 1);
  assert.equal(queue.tasks().length, 1);
  const first = await runQueuedTasks({ queue, workflow, context, log: () => {} });
  assert.equal(first[0].status, 'failed');
  assert.equal(first[0].summary.skipped, 1);
  assert.equal(first[0].summary.downloaded, 1);
  assert.equal(first[0].summary.failed, 1);
  assert.ok(navigations.every((url) => !url.includes('p=all')));
  failSecondPart = false;
  await queue.retry(all.id);
  const retry = await runQueuedTasks({ queue, workflow, context, log: () => {} });
  assert.equal(retry[0].status, 'completed');
  assert.equal(retry[0].summary.skipped, 2);
  assert.deepEqual(calls, [1, 2, 3, 2]);
  const refreshed = await queue.enqueue([`${videoUrl}?p=all`]);
  assert.equal(refreshed.refreshed[0].id, all.id);
  const synced = await runQueuedTasks({ queue, workflow, context, log: () => {} });
  assert.equal(synced[0].summary.skipped, 3);
  assert.equal(queue.tasks().length, 1);
});
