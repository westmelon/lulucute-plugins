import { afdianAttachmentId } from './common.mjs';

async function readPost(context, resource) {
  const params = { post_id: resource.postId };
  if (resource.albumId) params.album_id = resource.albumId;
  const response = await context.request.get('https://afdian.com/api/post/get-detail', {
    params
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (payload?.ec === 40100) {
    throw new Error('Afdian login is required; run the one-time --login flow first');
  }
  if (response.status() >= 400 || payload?.ec !== 200) {
    throw new Error(`Afdian post lookup failed: ${payload?.em || `HTTP ${response.status()}`}`);
  }
  const post = payload.data?.post;
  if (!post?.post_id) throw new Error('Afdian post information was missing');
  return post;
}

async function resolveAttachmentDownload(context, value) {
  const response = await context.request.get(value, {
    failOnStatusCode: false,
    maxRedirects: 0
  });
  const location = response.headers().location;
  if (response.status() >= 300 && response.status() < 400 && location) {
    return new URL(location, value).toString();
  }
  if (response.ok() && response.url() !== value) return response.url();
  throw new Error(`Afdian attachment redirect failed with HTTP ${response.status()}`);
}

export class AfdianProviderAdapter {
  match(resource) {
    return resource.provider === 'afdian';
  }

  async resolve(context, resource) {
    const post = await readPost(context, resource);
    let directUrl;

    if (resource.mediaType === 'video') directUrl = post.video;
    else if (resource.mediaType === 'audio') directUrl = post.audio;
    else if (resource.mediaType === 'attachment') {
      const attachment = (post.attachment || [])
        .find((item) => afdianAttachmentId(item) === resource.attachmentId);
      if (attachment?.download) {
        directUrl = await resolveAttachmentDownload(context, attachment.download);
      } else {
        directUrl = attachment?.url;
      }
    }

    if (!directUrl) {
      if (post.has_right === 0) {
        return {
          status: 'action-required',
          reason: 'afdian-content-locked',
          message: `Afdian access is required for ${post.title}`,
          resource
        };
      }
      throw new Error(`Afdian ${resource.mediaType} is no longer available for ${post.title}`);
    }
    return {
      ...resource,
      directUrl,
      headers: { Referer: resource.postUrl }
    };
  }
}
