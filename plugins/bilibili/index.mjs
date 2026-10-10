import { BilibiliForumAdapter } from './forum.mjs';
import { BilibiliProviderAdapter } from './provider.mjs';
import { normalizeBilibiliUrl, parseBilibiliUrl } from './common.mjs';

export function createAdapters({ config, services }) {
  const options = config.plugins?.options?.bilibili || {};
  const ffmpegPath = options.ffmpegPath ?? config.workflow?.bilibiliFfmpegPath ?? services.toolPaths?.ffmpeg ?? 'ffmpeg';
  const aria2Path = options.aria2Path ?? config.workflow?.bilibiliAria2Path ?? services.toolPaths?.aria2 ?? 'aria2c';
  for (const [name, value] of Object.entries({ ffmpegPath, aria2Path })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Bilibili ${name} must be a non-empty executable path`);
  }
  const forum = new BilibiliForumAdapter();
  forum.normalizeUrl = normalizeBilibiliUrl;
  forum.shouldRefresh = (url) => {
    const parsed = parseBilibiliUrl(url);
    return parsed?.type === 'collection' || parsed?.part === 'all';
  };
  return { forums: [forum], providers: [new BilibiliProviderAdapter({ ffmpegPath, aria2Path, services })] };
}
