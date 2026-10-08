import { AfdianForumAdapter } from './forum.mjs';
import { AfdianProviderAdapter } from './provider.mjs';
import { normalizeAfdianDynamicListUrl, isAfdianCollectionUrl } from './common.mjs';

export function createAdapters() {
  const forum = new AfdianForumAdapter();
  forum.normalizeUrl = normalizeAfdianDynamicListUrl;
  forum.shouldRefresh = isAfdianCollectionUrl;
  return { forums: [forum], providers: [new AfdianProviderAdapter()] };
}
