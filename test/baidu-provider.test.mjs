import test from 'node:test';
import assert from 'node:assert/strict';
import { clickBaiduHighSpeedDownload } from '../plugins/baidu/provider.mjs';

function createControl(label, clicked, clickError) {
  return {
    label,
    async isVisible() {
      return true;
    },
    async click() {
      clicked.push(label);
      if (clickError) throw clickError;
    }
  };
}

function createLocator(controls) {
  return {
    filter({ hasText }) {
      return createLocator(controls.filter((control) => hasText.test(control.label)));
    },
    async count() {
      return controls.length;
    },
    nth(index) {
      return controls[index];
    }
  };
}

function createPage(labels, { clickError } = {}) {
  const clicked = [];
  const controls = labels.map((label) => createControl(label, clicked, clickError));
  const empty = createLocator([]);
  return {
    clicked,
    page: {
      locator() {
        return createLocator(controls);
      },
      getByText() {
        return empty;
      },
      async waitForTimeout() {}
    }
  };
}

test('clickBaiduHighSpeedDownload clicks the high-speed download control', async () => {
  const { page, clicked } = createPage(['普通下载', '高速下载']);

  const result = await clickBaiduHighSpeedDownload(page, { timeoutMs: 1 });

  assert.equal(result, true);
  assert.deepEqual(clicked, ['高速下载']);
});

test('clickBaiduHighSpeedDownload accepts the recommended label', async () => {
  const { page, clicked } = createPage(['高速下载（推荐）']);

  const result = await clickBaiduHighSpeedDownload(page, { timeoutMs: 1 });

  assert.equal(result, true);
  assert.deepEqual(clicked, ['高速下载（推荐）']);
});

test('clickBaiduHighSpeedDownload keeps the original flow when no dialog appears', async () => {
  const { page, clicked } = createPage(['打开百度网盘客户端']);

  const result = await clickBaiduHighSpeedDownload(page, { timeoutMs: 1 });

  assert.equal(result, false);
  assert.deepEqual(clicked, []);
});

test('clickBaiduHighSpeedDownload tolerates client protocol navigation aborts', async () => {
  const { page, clicked } = createPage(
    ['高速下载'],
    { clickError: new Error('net::ERR_ABORTED at baiduyunguanjia://') }
  );

  const result = await clickBaiduHighSpeedDownload(page, { timeoutMs: 1 });

  assert.equal(result, true);
  assert.deepEqual(clicked, ['高速下载']);
});

test('clickBaiduHighSpeedDownload stops when the task is cancelled', async () => {
  const { page, clicked } = createPage(['高速下载']);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));

  await assert.rejects(
    () => clickBaiduHighSpeedDownload(page, { signal: controller.signal, timeoutMs: 1 }),
    /cancelled/
  );
  assert.deepEqual(clicked, []);
});
