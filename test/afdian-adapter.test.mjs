import test from 'node:test';
import assert from 'node:assert/strict';
import {
  afdianAttachmentId,
  normalizeAfdianDynamicListUrl,
  parseAfdianDynamicList
} from '../plugins/afdian/common.mjs';
import {
  AfdianForumAdapter,
  buildAfdianResources
} from '../plugins/afdian/forum.mjs';
import { AfdianProviderAdapter } from '../plugins/afdian/provider.mjs';

const albumId = '93148dc0ad3811f0a32e52540025c377';

function apiResponse(payload, { status = 200, url = 'https://afdian.com/api/test', headers = {} } = {}) {
  return {
    status: () => status,
    json: async () => payload,
    headers: () => headers,
    url: () => url,
    ok: () => status >= 200 && status < 300
  };
}

test('AfdianForumAdapter matches album and dynamic list URLs only', () => {
  const adapter = new AfdianForumAdapter();
  assert.equal(adapter.match(`https://afdian.com/album/${albumId}`), true);
  assert.equal(adapter.match(`https://afdian.net/album/${albumId}/`), true);
  assert.equal(adapter.match(`https://afdian.com/api/post/get-list?user_id=${albumId}`), true);
  assert.equal(adapter.match('https://afdian.com/api/post/get-list?user_id=invalid'), false);
  assert.equal(adapter.match(`https://afdian.com/album/${albumId}/post-id`), false);
  assert.equal(adapter.match('https://afdian.com/a/yezi233'), false);
});

test('Afdian dynamic list parsing keeps filters and removes pagination state', () => {
  const url = `https://afdian.net/api/post/get-list?user_id=${albumId}&type=old&publish_sn=123&per_page=10&plan_id=plan-one&group_id=&name=`;
  assert.deepEqual(parseAfdianDynamicList(url), {
    userId: albumId,
    params: { user_id: albumId, plan_id: 'plan-one' }
  });
  assert.equal(
    normalizeAfdianDynamicListUrl(url),
    `https://afdian.com/api/post/get-list?plan_id=plan-one&user_id=${albumId}`
  );
});

test('buildAfdianResources creates stable identities without signed media URLs', () => {
  const attachment = {
    title: '原始音频.wav',
    url: 'https://private.example.com/archive/original.wav',
    download: 'https://ifdian.net/api/tool/redirect?params=secret',
    size: 123
  };
  const source = {
    albumId,
    postCount: 65,
    forum: '爱发电',
    section: '创作者',
    threadTitle: '专辑'
  };
  const resources = buildAfdianResources([{
    post_id: 'post-one',
    rank: 1,
    title: '第一期',
    has_video: 1,
    video: 'https://vod.example.com/video.mp4?sign=temporary',
    has_audio: 1,
    audio: 'https://audio.example.com/audio.m4a?sign=temporary',
    attachment: [attachment]
  }], source);

  assert.deepEqual(resources.map((resource) => resource.mediaType), [
    'video',
    'audio',
    'attachment'
  ]);
  assert.deepEqual(resources.map((resource) => resource.filename), [
    '01 - 第一期.mp4',
    '01 - 第一期.m4a',
    '01 - 原始音频.wav'
  ]);
  assert.ok(resources.every((resource) => resource.preserveCompletion));
  assert.ok(resources.every((resource) => !resource.url.includes('temporary')));
  assert.match(resources[2].url, new RegExp(afdianAttachmentId(attachment)));
});

test('AfdianForumAdapter inspects metadata and follows rank pagination', async () => {
  const responses = [
    {
      status: 200,
      payload: {
        ec: 200,
        data: {
          album: {
            album_id: albumId,
            title: '40听觉向视频',
            order_by: 'rank asc',
            post_count: 2,
            user: { name: '其实是椰子啦', url_slug: 'yezi233' }
          }
        }
      }
    },
    {
      status: 200,
      payload: {
        ec: 200,
        data: {
          list: [{ post_id: 'one', rank: 1, title: '一期', has_video: 1 }],
          has_more: 1
        }
      }
    },
    {
      status: 200,
      payload: {
        ec: 200,
        data: {
          list: [{ post_id: 'two', rank: 2, title: '二期', has_audio: 1 }],
          has_more: 0
        }
      }
    }
  ];
  const calls = [];
  const page = {
    goto: async (url) => calls.push(['goto', url]),
    evaluate: async (_callback, args) => {
      calls.push(['evaluate', args]);
      return responses.shift();
    }
  };
  const adapter = new AfdianForumAdapter();
  const url = `https://afdian.com/album/${albumId}`;
  const state = await adapter.inspect(page, url);
  const resources = await adapter.extractResources(page, state.source);

  assert.equal(state.source.section, '其实是椰子啦');
  assert.equal(state.source.threadTitle, '40听觉向视频');
  assert.deepEqual(resources.map((resource) => resource.mediaType), ['video', 'audio']);
  assert.equal(calls[2][1].params.lastRank, '');
  assert.equal(calls[3][1].params.lastRank, '1');
});

test('AfdianForumAdapter inspects and paginates dynamic posts by publish_sn', async () => {
  const userId = 'cac601d6379e11ecb98e52540025c377';
  const planId = '60147034ea3611eca2f652540025c377';
  const responses = [
    {
      status: 200,
      payload: {
        ec: 200,
        data: {
          list: [{
            post_id: 'newest',
            title: '最新一期',
            publish_sn: 200,
            publish_time: 1_786_795_200,
            has_audio: 1,
            album_ids: [albumId],
            user: { name: '创作者', url_slug: 'creator' },
            unlock_plan: { plan_id: planId, name: '完整版' }
          }],
          has_more: 1
        }
      }
    },
    {
      status: 200,
      payload: {
        ec: 200,
        data: {
          list: [{
            post_id: 'newest',
            title: '最新一期',
            publish_sn: 200,
            publish_time: 1_786_795_200,
            has_audio: 1,
            album_ids: [albumId]
          }],
          has_more: 1
        }
      }
    },
    {
      status: 200,
      payload: {
        ec: 200,
        data: {
          list: [{
            post_id: 'older',
            title: '较早一期',
            publish_sn: 100,
            publish_time: 1_786_708_800,
            has_video: 1
          }],
          has_more: 0
        }
      }
    }
  ];
  const calls = [];
  const page = {
    goto: async (url) => calls.push(['goto', url]),
    evaluate: async (_callback, args) => {
      calls.push(['evaluate', args]);
      return responses.shift();
    }
  };
  const url = `https://afdian.com/api/post/get-list?user_id=${userId}&plan_id=${planId}&publish_sn=999`;
  const adapter = new AfdianForumAdapter();
  const state = await adapter.inspect(page, url);
  const resources = await adapter.extractResources(page, state.source);

  assert.equal(state.source.section, '创作者');
  assert.equal(state.source.threadTitle, '完整版');
  assert.equal(state.source.sourceType, 'dynamic');
  assert.equal(state.source.postCount, 2);
  assert.deepEqual(resources.map((resource) => resource.mediaType), ['audio', 'video']);
  assert.ok(resources.every((resource) => !('albumId' in resource)));
  assert.match(resources[0].url, /^https:\/\/afdian\.com\/p\/newest\?resource=audio$/);
  assert.deepEqual(resources[0].aliasUrls, [
    `https://afdian.com/album/${albumId}/newest?resource=audio`
  ]);
  assert.equal(calls[0][1], 'https://afdian.com');
  assert.equal(calls[2][1].params.publish_sn, '');
  assert.equal(calls[3][1].params.publish_sn, '200');
  assert.equal(calls[3][1].params.plan_id, planId);
});

test('AfdianProviderAdapter refreshes video URLs immediately before download', async () => {
  const calls = [];
  const context = {
    request: {
      get: async (url, options) => {
        calls.push({ url, options });
        return apiResponse({
          ec: 200,
          data: {
            post: {
              post_id: 'post-one',
              title: '第一期',
              has_right: 1,
              video: 'https://vod.afdiancdn.com/video.mp4?sign=fresh'
            }
          }
        });
      }
    }
  };
  const resource = {
    provider: 'afdian',
    mediaType: 'video',
    albumId,
    postId: 'post-one',
    postUrl: `https://afdian.com/album/${albumId}/post-one`,
    url: `https://afdian.com/album/${albumId}/post-one?resource=video`,
    filename: '01 - 第一期.mp4'
  };

  const resolved = await new AfdianProviderAdapter().resolve(context, resource);

  assert.equal(resolved.directUrl, 'https://vod.afdiancdn.com/video.mp4?sign=fresh');
  assert.equal(resolved.headers.Referer, resource.postUrl);
  assert.equal(calls[0].options.params.post_id, 'post-one');
});

test('AfdianProviderAdapter refreshes dynamic posts without album_id', async () => {
  const calls = [];
  const context = {
    request: {
      get: async (url, options) => {
        calls.push({ url, options });
        return apiResponse({
          ec: 200,
          data: {
            post: {
              post_id: 'dynamic-post',
              title: '动态音频',
              has_right: 1,
              audio: 'https://audio.afdiancdn.com/audio.m4a?sign=fresh'
            }
          }
        });
      }
    }
  };
  const resource = {
    provider: 'afdian',
    mediaType: 'audio',
    postId: 'dynamic-post',
    postUrl: 'https://afdian.com/p/dynamic-post',
    url: 'https://afdian.com/p/dynamic-post?resource=audio',
    filename: 'dynamic.m4a'
  };

  const resolved = await new AfdianProviderAdapter().resolve(context, resource);

  assert.equal(resolved.directUrl, 'https://audio.afdiancdn.com/audio.m4a?sign=fresh');
  assert.deepEqual(calls[0].options.params, { post_id: 'dynamic-post' });
});

test('AfdianProviderAdapter resolves authenticated attachment redirects', async () => {
  const attachment = {
    title: '原始音频.wav',
    url: 'https://private.example.com/original.wav',
    download: 'https://ifdian.net/api/tool/redirect?params=temporary'
  };
  const responses = [
    apiResponse({
      ec: 200,
      data: {
        post: {
          post_id: 'post-one',
          title: '第一期',
          has_right: 1,
          attachment: [attachment]
        }
      }
    }),
    apiResponse(null, {
      status: 302,
      headers: { location: 'https://download.example.com/original.wav?sign=fresh' }
    })
  ];
  const context = { request: { get: async () => responses.shift() } };
  const resolved = await new AfdianProviderAdapter().resolve(context, {
    provider: 'afdian',
    mediaType: 'attachment',
    attachmentId: afdianAttachmentId(attachment),
    albumId,
    postId: 'post-one',
    postUrl: `https://afdian.com/album/${albumId}/post-one`,
    url: `https://afdian.com/album/${albumId}/post-one?resource=attachment`,
    filename: '01 - 原始音频.wav'
  });

  assert.equal(resolved.directUrl, 'https://download.example.com/original.wav?sign=fresh');
});
