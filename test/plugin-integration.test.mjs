import { coreModule } from './helpers/core.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
const { createWorkflow } = await coreModule('src/app-runtime.mjs');
const { loadLocalPlugins } = await coreModule('src/core/plugin-loader.mjs');

async function writePlugin(root, manifest, source) {
  const directory = path.join(root, manifest.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify(manifest));
  if (source) await writeFile(path.join(directory, 'index.mjs'), source);
  return directory;
}

test('shipped site bundles are loaded together and disabled sites have no built-in fallback', async () => {
  const { pluginConfig } = await import('./helpers/plugins.mjs');
  const config = { downloadRoot: '/tmp/plugin-tests', workflow: {}, plugins: pluginConfig };
  const plugins = await loadLocalPlugins(config, { log: () => {} });
  assert.equal(plugins.forums.length, 3);
  assert.equal(plugins.providers.length, 4);
  assert.deepEqual(plugins.sites.map((site) => site.id), ['bilibili', 'afdian', 'hifiti']);
  assert.equal(plugins.sites[0].actions[0].query.p, 'all');
  const disabled = await loadLocalPlugins({ ...config, plugins: { ...pluginConfig, enabled: [] } });
  const registry = createWorkflow(config, disabled).registry;
  assert.throws(() => registry.forumFor('https://www.bilibili.com/video/BV1xx411c7mD'), /No forum/);
  assert.throws(() => registry.providerFor({ provider: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }), /No provider/);
  assert.throws(() => registry.providerFor({ url: 'https://pan.baidu.com/s/example' }), /No provider/);
  assert.throws(() => registry.providerFor({ provider: 'direct', url: 'https://hifinicc.lanzouu.com/example' }), /No provider/);
  assert.equal((await registry.providerFor({ url: 'https://files.example.com/song.mp3' })
    .resolve({}, { url: 'https://files.example.com/song.mp3' })).directUrl, 'https://files.example.com/song.mp3');
});

test('a new provider plugin handles HiFiTi resource links without changing the website parser', async (t) => {
  const { parseHifitiResourceSections } = await import('../plugins/hifiti/forum.mjs');
  const { DownloadWorkflow } = await coreModule('src/core/workflow.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-cloud-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writePlugin(root, { id: 'custom-cloud', type: 'provider', apiVersion: 1,
    entry: './index.mjs', hosts: ['cloud.example.com'] }, `
    export function createAdapter() {
      return { match: (resource) => new URL(resource.url).hostname === 'cloud.example.com',
        resolve: async (_context, resource) => ({ ...resource,
          directUrl: 'https://media.example.com/song.mp3', headers: { 'X-Code': resource.code } }) };
    }
  `);
  const plugins = await loadLocalPlugins({ plugins: { directories: [root], enabled: ['custom-cloud'] } });
  const source = { forum: 'Test', section: 'Music', threadTitle: 'Album' };
  const resources = parseHifitiResourceSections({ download: ['https://cloud.example.com/share/one'], extractionCode: 'abcd' });
  const registry = createWorkflow({ workflow: {} }, plugins).registry;
  registry.forums.push({ match: () => true, inspect: async () => ({ locked: false, source }),
    extractResources: async () => resources });
  let downloaded;
  const workflow = new DownloadWorkflow({ registry, config: { downloadRoot: root, workflow: {} },
    downloader: { download: async (options) => { downloaded = options; return { path: '/fixture.mp3' }; } } });
  const result = await workflow.run({ newPage: async () => ({ close: async () => {} }) }, 'https://forum.example.com/one');
  assert.equal(result.results[0].status, 'downloaded');
  assert.equal(downloaded.directUrl, 'https://media.example.com/song.mp3');
  assert.equal(downloaded.headers['X-Code'], 'abcd');
});

test('shipped plugin packages can be installed in a different directory without source-code dependencies', async (t) => {
  const { cp } = await import('node:fs/promises');
  const { pluginConfig } = await import('./helpers/plugins.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-relocated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const id of pluginConfig.enabled) await cp(path.join(pluginConfig.directories[0], id), path.join(root, id), { recursive: true });
  const plugins = await loadLocalPlugins({ downloadRoot: root, workflow: {},
    plugins: { ...pluginConfig, directories: [root] } }, { log: () => {} });
  assert.equal(plugins.forums.length, 3);
  assert.equal(plugins.providers.length, 4);
  const provider = createWorkflow({}, plugins).registry.providerFor({ url: 'https://pan.baidu.com/s/share' });
  assert.equal(provider.monitor.root, root);
  assert.equal(typeof provider.allocateAvailablePath, 'function');
});
