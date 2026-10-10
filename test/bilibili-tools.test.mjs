import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from '../plugins/bilibili/index.mjs';

const services = { toolPaths: { aria2: '/plugin tools/aria2c', ffmpeg: '/plugin tools/ffmpeg' },
  Aria2Downloader: class { constructor({ executable }) { this.executable = executable; } } };

test('Bilibili uses installed tool paths and preserves explicit and legacy overrides', () => {
  const provider = createAdapters({ config: {}, services }).providers[0];
  assert.equal(provider.ffmpegPath, services.toolPaths.ffmpeg);
  assert.equal(provider.downloader.executable, services.toolPaths.aria2);
  const config = { plugins: { options: { bilibili: { aria2Path: '/custom aria2c', ffmpegPath: '/custom ffmpeg' } } } };
  const overridden = createAdapters({ config, services }).providers[0];
  assert.equal(overridden.ffmpegPath, '/custom ffmpeg');
  assert.equal(overridden.downloader.executable, '/custom aria2c');
  const legacy = createAdapters({ config: { workflow: { bilibiliAria2Path: '/legacy aria2c' } }, services }).providers[0];
  assert.equal(legacy.downloader.executable, '/legacy aria2c');
  const fallback = createAdapters({ config: {}, services: { ...services, toolPaths: undefined } }).providers[0];
  assert.equal(fallback.ffmpegPath, 'ffmpeg');
  assert.equal(fallback.downloader.executable, 'aria2c');
});
