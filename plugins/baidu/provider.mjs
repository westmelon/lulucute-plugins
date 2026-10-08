import path from 'node:path';
import { mkdir } from 'node:fs/promises';

async function firstVisible(locator) {
  const count = Math.min(await locator.count(), 20);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function waitForFirstVisible(page, locator, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidate = await firstVisible(locator);
    if (candidate) return candidate;
    await page.waitForTimeout(200);
  }
  return null;
}

async function actionableControl(element) {
  const ancestor = element.locator(
    'xpath=ancestor-or-self::*[self::button or self::a or @role="button"][1]'
  );
  return await ancestor.count() ? ancestor : element;
}

async function isChecked(element) {
  return element.evaluate((node) => (
    node.checked === true
    || node.getAttribute('aria-checked') === 'true'
    || /(?:^|\s)(?:checked|selected)(?:\s|$)/i.test(node.className || '')
  ));
}

async function isDisabled(element) {
  return element.evaluate((node) => {
    for (let current = node; current && current !== document.body; current = current.parentElement) {
      if (current.disabled || current.getAttribute('aria-disabled') === 'true') return true;
      if (/(?:^|\s)(?:disabled|is-disabled)(?:\s|$)/i.test(current.className || '')) return true;
      if (current.matches('button, a, [role="button"]')) break;
    }
    return false;
  });
}

export async function selectBaiduDownloadItems(page) {
  const selectors = [
    '[aria-label*="全选"]',
    '[title*="全选"]',
    '[data-testid*="select-all" i]',
    '[data-key="selectAll"]',
    '.select-all',
    '.check-all',
    '.list-header [class*="checkbox"]',
    '.list-header [class*="check-box"]',
    '.wp-s-agile-tool-bar__header-checkbox',
    '.nd-main-list__select-all',
    '.wp-s-core-pan-file-list__header [class*="check"]',
    '.module-list-view .list-header-operatearea .checkbox'
  ];

  for (const selector of selectors) {
    const selection = await firstVisible(page.locator(selector));
    if (!selection) continue;
    if (!await isChecked(selection)) await selection.click();
    await page.waitForTimeout(300);
    return selector;
  }

  const selectAllText = await firstVisible(page.getByText('全选', { exact: true }));
  if (selectAllText) {
    const selection = await actionableControl(selectAllText);
    if (!await isChecked(selection)) await selection.click();
    await page.waitForTimeout(300);
    return 'text:全选';
  }

  return null;
}

export async function findBaiduDownloadButton(page) {
  const text = await waitForFirstVisible(page, page.getByText('下载', { exact: true }));
  return text ? actionableControl(text) : null;
}

export async function findBaiduHighSpeedDownloadButton(page, timeoutMs = 5_000) {
  const label = /^\s*高速下载(?:\s*[（(]推荐[）)])?\s*$/;
  const control = await waitForFirstVisible(
    page,
    page.locator('button, a, [role="button"]').filter({ hasText: label }),
    timeoutMs
  );
  if (control) return control;

  const text = await firstVisible(page.getByText(label));
  return text ? actionableControl(text) : null;
}

export async function clickBaiduHighSpeedDownload(page, { signal, timeoutMs } = {}) {
  signal?.throwIfAborted();
  const control = await findBaiduHighSpeedDownloadButton(page, timeoutMs);
  if (!control) return false;

  signal?.throwIfAborted();
  await control.click().catch((error) => {
    if (!/ERR_ABORTED/i.test(error.message)) throw error;
  });
  signal?.throwIfAborted();
  return true;
}

export async function submitExtractionCode(page, passwordInput) {
  const submit = await firstVisible(page.locator([
    'button:has-text("提取文件")',
    'a:has-text("提取文件")',
    '[role="button"]:has-text("提取文件")',
    '.g-button:has-text("提取文件")',
    '.wp-s-agile-button:has-text("提取文件")',
    '.pickpw button',
    '.pickpw a',
    'input[type="submit"]'
  ].join(',')));

  if (submit) await submit.click();
  else await passwordInput.press('Enter');

  const unlocked = await passwordInput.waitFor({ state: 'hidden', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  return { submittedBy: submit ? 'control' : 'enter', unlocked };
}

async function visibleControlLabels(page) {
  return page.locator('button, [role="button"], a').evaluateAll((elements) => elements
    .filter((element) => {
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length;
    })
    .map((element) => element.textContent.trim())
    .filter(Boolean)
    .slice(0, 20));
}

export class BaiduProviderAdapter {
  constructor({ monitor, services }) {
    this.monitor = monitor;
    this.allocateAvailablePath = services.allocateAvailablePath;
  }

  match(resource) {
    return resource.provider === 'baidu'
      || ((!resource.provider || resource.provider === 'direct') && new URL(resource.url).hostname === 'pan.baidu.com');
  }

  async resolve(context, resource, { directory, signal } = {}) {
    if (!directory) throw new Error('Baidu download destination is required');
    signal?.throwIfAborted();

    const baseline = await this.monitor.captureBaseline();
    const page = await context.newPage();
    let completed = false;

    const browserDownload = new Promise((resolve) => {
      page.once('download', async (download) => {
        try {
          await mkdir(directory, { recursive: true });
          const filename = download.suggestedFilename() || 'baidu-download';
          const target = await this.allocateAvailablePath(directory, path.basename(filename));
          await download.saveAs(target);
          resolve({ status: 'completed', paths: [target], method: 'browser' });
        } catch (error) {
          resolve({ status: 'action-required', reason: 'browser-download-failed', error: error.message });
        }
      });
    });

    try {
      await page.goto(resource.url, { waitUntil: 'domcontentloaded' });
      signal?.throwIfAborted();

      const passwordInput = await firstVisible(page.locator([
        'input[placeholder*="提取码"]',
        'input[placeholder*="密码"]',
        '.pickpw input'
      ].join(',')));
      if (passwordInput) {
        if (!resource.code) {
          return { status: 'action-required', resource, message: 'Baidu extraction code is required.' };
        }
        await passwordInput.fill(resource.code);
        console.error('[resource-downloader] Submitting Baidu extraction code');
        const submission = await submitExtractionCode(page, passwordInput);
        if (!submission.unlocked) {
          const labels = await visibleControlLabels(page);
          return {
            status: 'action-required',
            resource,
            reason: 'extraction-not-unlocked',
            message: `Baidu extraction form remained visible after submission by ${submission.submittedBy}.`,
            visibleControls: labels
          };
        }
        console.error('[resource-downloader] Baidu share page unlocked');
      }

      signal?.throwIfAborted();
      const selectionMethod = await selectBaiduDownloadItems(page);
      if (selectionMethod) {
        console.error(`[resource-downloader] Selected Baidu resources using ${selectionMethod}`);
      }

      const downloadButton = await findBaiduDownloadButton(page);
      if (downloadButton) {
        if (await isDisabled(downloadButton)) {
          const labels = await visibleControlLabels(page);
          return {
            status: 'action-required',
            resource,
            reason: 'download-control-disabled',
            message: 'Baidu download control is disabled because no resource was selected.',
            visibleControls: labels
          };
        }
        await downloadButton.click().catch((error) => {
          if (!/ERR_ABORTED/i.test(error.message)) throw error;
        });
        console.error('[resource-downloader] Clicked Baidu download control');
        const highSpeedClicked = await clickBaiduHighSpeedDownload(page, { signal });
        if (highSpeedClicked) {
          console.error('[resource-downloader] Clicked Baidu high-speed download control');
        }

        signal?.throwIfAborted();
        const openClientText = await waitForFirstVisible(
          page,
          page.getByText(
            /打开.*(?:百度网盘|客户端)|启动.*客户端|使用.*客户端下载/,
            { exact: false }
          ),
          5_000
        );
        if (openClientText) {
          const openClient = await actionableControl(openClientText);
          await openClient.click().catch((error) => {
            if (!/ERR_ABORTED/i.test(error.message)) throw error;
          });
          console.error('[resource-downloader] Clicked Baidu client launch control');
        }
      } else {
        const labels = await visibleControlLabels(page);
        console.error('[resource-downloader] Baidu download control was not found. Complete login or verification in the open page, then click Download.');
        console.error(`[resource-downloader] Visible Baidu controls: ${labels.join(' | ') || '(none)'}`);
      }

      console.error(`[resource-downloader] Waiting for Baidu download completion in ${this.monitor.root}`);
      const abortController = new AbortController();
      const cancelMonitor = () => abortController.abort(signal.reason);
      if (signal?.aborted) cancelMonitor();
      else signal?.addEventListener('abort', cancelMonitor, { once: true });
      const externalDownload = this.monitor.waitForCompleted({
        baseline,
        destination: directory,
        signal: abortController.signal
      }).then((result) => ({ ...result, method: 'baidu-client' }));
      const result = await Promise.race([browserDownload, externalDownload]);
      abortController.abort(new Error('Another Baidu download path completed'));
      signal?.removeEventListener('abort', cancelMonitor);
      signal?.throwIfAborted();

      if (result.status === 'completed') {
        completed = true;
        return {
          status: 'downloaded',
          resource,
          download: { method: result.method, paths: result.paths }
        };
      }

      return {
        status: 'action-required',
        resource,
        message: result.reason === 'browser-download-failed'
          ? `Baidu browser download failed: ${result.error}`
          : 'Baidu download did not complete before the configured timeout.',
        reason: result.reason,
        candidates: result.candidates
      };
    } finally {
      if (completed || signal?.aborted) await page.close().catch(() => {});
    }
  }
}
