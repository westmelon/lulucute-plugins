import { coreModule } from './helpers/core.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
const { loadConfig } = await coreModule('src/config.mjs');
const { loadLocalPlugins } = await coreModule('src/core/plugin-loader.mjs');
import { pluginConfig } from './helpers/plugins.mjs';

test('Bilibili plugin accepts legacy tool paths and rejects empty values when enabled', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resource-config-ffmpeg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const raw = { downloadRoot: path.join(root, 'downloads'),
    plugins: { ...pluginConfig, enabled: ['bilibili'] }, workflow: {
    bilibiliFfmpegPath: '/tools/ffmpeg', bilibiliAria2Path: '/tools/aria2c'
  } };
  await writeFile(configPath, JSON.stringify(raw));
  assert.equal((await loadConfig(configPath)).workflow.bilibiliFfmpegPath, '/tools/ffmpeg');
  assert.equal((await loadConfig(configPath)).workflow.bilibiliAria2Path, '/tools/aria2c');
  const loaded = await loadLocalPlugins(await loadConfig(configPath), { log: () => {} });
  assert.equal(loaded.providers[0].ffmpegPath, '/tools/ffmpeg');
  assert.equal(loaded.providers[0].downloader.executable, '/tools/aria2c');
  raw.workflow.bilibiliFfmpegPath = '';
  await writeFile(configPath, JSON.stringify(raw));
  await assert.rejects(async () => loadLocalPlugins(await loadConfig(configPath)), /ffmpegPath/);
  raw.workflow.bilibiliFfmpegPath = '/tools/ffmpeg';
  raw.workflow.bilibiliAria2Path = '';
  await writeFile(configPath, JSON.stringify(raw));
  await assert.rejects(async () => loadLocalPlugins(await loadConfig(configPath)), /aria2Path/);
  raw.plugins.enabled = [];
  await writeFile(configPath, JSON.stringify(raw));
  assert.equal((await loadLocalPlugins(await loadConfig(configPath))).providers.length, 0);
  raw.plugins.enabled = ['bilibili'];
  raw.plugins.options = { bilibili: { ffmpegPath: '/modern/ffmpeg', aria2Path: '/modern/aria2c' } };
  await writeFile(configPath, JSON.stringify(raw));
  const modern = await loadLocalPlugins(await loadConfig(configPath), { log: () => {} });
  assert.equal(modern.providers[0].ffmpegPath, '/modern/ffmpeg');
  assert.equal(modern.providers[0].downloader.executable, '/modern/aria2c');
});

