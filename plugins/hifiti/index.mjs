import { HifitiForumAdapter } from './forum.mjs';

export function createAdapter() {
  const forum = new HifitiForumAdapter();
  forum.normalizeUrl = (value) => {
    const url = new URL(value);
    const thread = url.pathname.match(/^\/thread-(\d+)(?:-\d+)?\.htm$/i);
    if (!forum.match(value) || !thread) return null;
    return `https://www.hifiti.com/thread-${thread[1]}.htm`;
  };
  return forum;
}
