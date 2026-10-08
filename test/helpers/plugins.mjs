import { fileURLToPath } from 'node:url';
import { coreModule } from './core.mjs';
const { loadLocalPlugins } = await coreModule('src/core/plugin-loader.mjs');

export const pluginConfig = {
  directories: [fileURLToPath(new URL('../../plugins/', import.meta.url))],
  enabled: ['bilibili', 'afdian', 'hifiti', 'baidu', 'lanzou'],
  options: {}
};
export const testPlugins = await loadLocalPlugins({
  downloadRoot: '/tmp/resource-downloader-tests', workflow: {}, plugins: pluginConfig
}, { log: () => {} });
