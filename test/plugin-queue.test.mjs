import { coreModule } from './helpers/core.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
const { normalizeTaskUrl: normalizeCoreUrl, TaskQueue } = await coreModule('src/core/task-queue.mjs');

import { testPlugins } from './helpers/plugins.mjs';

const normalizeTaskUrl = (value) => normalizeCoreUrl(value, testPlugins.forums);

async function createQueue(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'tasks.json');
  const queue = await new TaskQueue(filePath, testPlugins).open();
  t.after(() => queue.close());
  return { filePath, queue };
}

test('normalizeTaskUrl treats HiFiTi thread variants as one task', () => {
  assert.equal(
    normalizeTaskUrl('http://hifiti.com/thread-1228.htm?sort=desc#postlist'),
    'https://www.hifiti.com/thread-1228.htm'
  );
  assert.equal(
    normalizeTaskUrl('https://www.hifiti.com/thread-1228-3.htm'),
    'https://www.hifiti.com/thread-1228.htm'
  );
});

test('normalizeTaskUrl removes Afdian dynamic pagination state and empty filters', () => {
  const userId = 'cac601d6379e11ecb98e52540025c377';
  assert.equal(
    normalizeTaskUrl(`https://afdian.net/api/post/get-list?user_id=${userId}&type=old&publish_sn=123&per_page=10&group_id=&plan_id=plan-one&name=`),
    `https://afdian.com/api/post/get-list?plan_id=plan-one&user_id=${userId}`
  );
});

test('TaskQueue persists tasks and ignores duplicate thread URLs', async (t) => {
  const { filePath, queue } = await createQueue(t);
  const result = await queue.enqueue([
    'https://www.hifiti.com/thread-1228.htm',
    'https://www.hifiti.com/thread-1228.htm?sort=desc#postlist',
    'https://www.hifiti.com/thread-1228-1.htm'
  ]);

  assert.equal(result.added.length, 1);
  assert.equal(result.existing.length, 2);
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.tasks.length, 1);
  assert.equal(persisted.tasks[0].status, 'pending');
});

test('TaskQueue refreshes a completed Afdian album without creating another task', async (t) => {
  const { queue } = await createQueue(t);
  const url = 'https://afdian.com/album/93148dc0ad3811f0a32e52540025c377';
  const { added: [task] } = await queue.enqueue([url]);
  await queue.markCompleted(task.id, { downloaded: 1 });

  const result = await queue.enqueue([url]);

  assert.equal(result.added.length, 0);
  assert.equal(result.existing.length, 0);
  assert.deepEqual(result.refreshed.map((item) => item.id), [task.id]);
  assert.equal(queue.requireTask(task.id).status, 'pending');
  assert.equal(queue.requireTask(task.id).stage, 'sync-queued');
});

test('TaskQueue refreshes a completed Afdian dynamic list with a different cursor', async (t) => {
  const { queue } = await createQueue(t);
  const userId = 'cac601d6379e11ecb98e52540025c377';
  const firstUrl = `https://afdian.com/api/post/get-list?user_id=${userId}&plan_id=plan-one&publish_sn=`;
  const { added: [task] } = await queue.enqueue([firstUrl]);
  await queue.markCompleted(task.id, { downloaded: 1 });

  const result = await queue.enqueue([
    `https://afdian.com/api/post/get-list?type=old&per_page=10&publish_sn=999&plan_id=plan-one&user_id=${userId}`
  ]);

  assert.equal(result.added.length, 0);
  assert.equal(result.existing.length, 0);
  assert.deepEqual(result.refreshed.map((item) => item.id), [task.id]);
  assert.equal(queue.requireTask(task.id).status, 'pending');
  assert.equal(queue.requireTask(task.id).stage, 'sync-queued');
});

test('plugin normalization reuses legacy task IDs and completed resource fingerprints', async (t) => {
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-queue-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'tasks.json');
  const canonical = 'https://www.bilibili.com/video/BV1xx411c7mD?p=1';
  const key = createHash('sha256').update(canonical).digest('hex');
  const old = { version: 1, tasks: [{ id: 'legacy-id', url: canonical, status: 'completed', attempts: 1 }],
    resources: [{ key, provider: 'bilibili', taskId: 'legacy-id', preserveCompletion: true }] };
  await writeFile(filePath, JSON.stringify(old));
  const queue = await new TaskQueue(filePath, testPlugins).open();
  t.after(() => queue.close());
  const result = await queue.enqueue(['https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=share']);
  assert.equal(result.existing[0].id, 'legacy-id');
  assert.equal(queue.hasCompletedResource(`${canonical}&spm_id_from=share`), true);
  assert.deepEqual(queue.data.resources, old.resources);
});
