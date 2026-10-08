import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HifitiForumAdapter,
  interpretHifitiReplyResponse,
  parseHifitiResourceSections
} from '../plugins/hifiti/forum.mjs';

test('parseHifitiResourceSections maps primary and backup links', () => {
  const resources = parseHifitiResourceSections({
    download: ['https://pan.baidu.com/s/example'],
    extractionCode: '提取码: xm68',
    backup: '下载:https://hifinicc.lanzouu.com/example 密码:atzg'
  });

  assert.deepEqual(resources, [
    {
      url: 'https://pan.baidu.com/s/example',
      code: 'xm68'
    },
    {
      url: 'https://hifinicc.lanzouu.com/example',
      code: 'atzg'
    }
  ]);
});

test('interpretHifitiReplyResponse recognizes accepted and rejected JSON responses', () => {
  assert.deepEqual(
    interpretHifitiReplyResponse({ body: '[0,"回复成功"]' }),
    { outcome: 'accepted', message: '回复成功' }
  );
  assert.deepEqual(
    interpretHifitiReplyResponse({ body: '{"code":-1,"message":"请先登录"}' }),
    { outcome: 'rejected', message: '请先登录' }
  );
  assert.deepEqual(
    interpretHifitiReplyResponse({ status: 429, body: '' }),
    { outcome: 'rejected', message: 'HTTP 429' }
  );
  assert.deepEqual(
    interpretHifitiReplyResponse({ body: '<html>unknown response</html>' }),
    { outcome: 'unknown', message: '' }
  );
});

test('HifitiForumAdapter reports the forum reply rejection message', async () => {
  let filled;
  let clicked = false;
  const form = {
    async count() { return 1; },
    async getAttribute() { return '/post-create.htm'; },
    locator(selector) {
      if (selector === 'textarea[name="message"]') {
        return { fill: async (value) => { filled = value; } };
      }
      return { click: async () => { clicked = true; } };
    }
  };
  const response = {
    request: () => ({ method: () => 'POST' }),
    url: () => 'https://www.hifiti.com/post-create.htm',
    status: () => 200,
    text: async () => '{"code":-1,"message":"两次回复间隔太短"}'
  };
  const page = {
    locator: (selector) => selector === '#quick_reply_form'
      ? form
      : { count: async () => 0 },
    url: () => 'https://www.hifiti.com/thread-555.htm',
    waitForResponse: async (predicate) => {
      assert.equal(predicate(response), true);
      return response;
    },
    waitForFunction: async () => { throw new Error('timeout'); }
  };

  await assert.rejects(
    () => new HifitiForumAdapter().reply(page, '感谢分享'),
    /HiFiTi reply failed: 两次回复间隔太短/
  );
  assert.equal(filled, '感谢分享');
  assert.equal(clicked, true);
});
