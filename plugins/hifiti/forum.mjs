function normalizeExtractionCode(value) {
  const text = String(value || '').trim();
  const labelled = text.match(/(?:提取码|密码)\s*[:：]?\s*([A-Za-z0-9]+)/i)?.[1];
  if (labelled) return labelled;
  return text.match(/^[A-Za-z0-9]+$/)?.[0] || null;
}

function cleanReplyMessage(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function interpretHifitiReplyResponse({ status = 200, body = '' } = {}) {
  if (status >= 400) {
    return { outcome: 'rejected', message: `HTTP ${status}` };
  }

  const text = String(body || '').trim();
  if (!text || !/^[{[]/.test(text)) return { outcome: 'unknown', message: '' };

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { outcome: 'unknown', message: '' };
  }

  const code = Array.isArray(payload)
    ? payload[0]
    : payload?.code ?? payload?.success ?? payload?.status;
  const message = cleanReplyMessage(
    Array.isArray(payload) ? payload[1] : payload?.message ?? payload?.msg ?? payload?.error
  );
  if (code === 0 || code === '0' || code === true || /^(?:ok|success)$/i.test(String(code))) {
    return { outcome: 'accepted', message };
  }
  if (code !== undefined && code !== null) {
    return { outcome: 'rejected', message: message || `code ${code}` };
  }
  return { outcome: 'unknown', message };
}

async function waitForReplyResponse(page, form, timeoutMs = 10_000) {
  const action = await form.getAttribute('action').catch(() => null);
  const currentUrl = page.url();
  const target = action ? new URL(action, currentUrl) : null;
  return page.waitForResponse((response) => {
    if (response.request().method() !== 'POST') return false;
    const responseUrl = new URL(response.url());
    return target
      ? responseUrl.origin === target.origin && responseUrl.pathname === target.pathname
      : responseUrl.origin === new URL(currentUrl).origin;
  }, { timeout: timeoutMs }).catch(() => null);
}

async function readReplyResponse(response) {
  if (!response) return { outcome: 'unknown', message: '' };
  const body = await response.text().catch(() => '');
  return interpretHifitiReplyResponse({ status: response.status(), body });
}

async function visibleReplyFeedback(page) {
  const locator = page.locator([
    '[role="alert"]',
    '.alert',
    '.toast',
    '.toast-message',
    '.layui-layer-content',
    '.modal-body'
  ].join(','));
  const count = Math.min(await locator.count(), 20);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const message = cleanReplyMessage(await candidate.textContent().catch(() => ''));
    if (message) return message;
  }
  return '';
}

export function parseHifitiResourceSections({ download = [], extractionCode = '', backup = '' }) {
  const primaryCode = normalizeExtractionCode(extractionCode);
  const resources = download.map((url) => ({
    url,
    code: primaryCode
  }));
  const backupUrls = [...backup.matchAll(/https?:\/\/[^\s]+/g)].map((match) => match[0]);
  const backupCode = backup.match(/(?:密码|提取码)\s*[:：]\s*([A-Za-z0-9]+)/i)?.[1] || null;

  for (const url of backupUrls) {
    resources.push({ url, code: backupCode });
  }

  return resources.filter(
    (resource, index, all) => all.findIndex((candidate) => candidate.url === resource.url) === index
  );
}

export class HifitiForumAdapter {
  match(url) {
    try {
      return /(^|\.)hifiti\.com$/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  async inspect(page, url, { navigate = true } = {}) {
    if (navigate) await page.goto(url, { waitUntil: 'domcontentloaded' });
    return page.evaluate(() => {
      const loginLink = document.querySelector('a[href*="user-login"]');
      const replyForm = document.querySelector('#quick_reply_form');
      const title = document.querySelector('main h4')?.textContent?.trim() || document.title;
      const section = [...document.querySelectorAll('main a[href^="forum-"]')]
        .map((element) => element.textContent.trim())
        .find(Boolean) || 'unknown';
      const threadId = location.pathname.match(/thread-(\d+)/)?.[1] || 'unknown';
      const locked = document.body.innerText.includes('本帖含有隐藏内容');

      if (locked && (loginLink || !replyForm)) {
        throw new Error('HiFiTi login is required; run the one-time --login flow first');
      }

      return {
        locked,
        source: {
          forum: 'HiFiTi',
          section,
          threadId,
          threadTitle: title
        }
      };
    });
  }

  async reply(page, message) {
    const form = page.locator('#quick_reply_form');
    if (await form.count() === 0) throw new Error('HiFiTi quick reply form was not found');

    await form.locator('textarea[name="message"]').fill(message);
    const responsePromise = waitForReplyResponse(page, form);
    const unlockedPromise = page.waitForFunction(
      () => !document.body.innerText.includes('本帖含有隐藏内容'),
      null,
      { timeout: 10_000 }
    ).then(() => true).catch(() => false);
    await form.locator('button[type="submit"]').click();
    const [response, unlocked] = await Promise.all([responsePromise, unlockedPromise]);
    if (unlocked) return;

    const result = await readReplyResponse(response);
    if (result.outcome === 'rejected') {
      throw new Error(`HiFiTi reply failed: ${result.message}`);
    }
    const feedback = await visibleReplyFeedback(page);
    if (feedback) throw new Error(`HiFiTi reply failed: ${feedback}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    const stillLocked = await page.evaluate(() =>
      document.body.innerText.includes('本帖含有隐藏内容')
    );
    if (!stillLocked) return;
    if (result.outcome === 'accepted') {
      throw new Error('HiFiTi accepted the reply but hidden content is still locked');
    }
    throw new Error('HiFiTi did not confirm the reply; hidden content is still locked');
  }

  async extractResources(page, source) {
    const sections = await page.evaluate(() => {
      const readSection = (name) => {
        const heading = [...document.querySelectorAll('h5')]
          .find((element) => element.textContent.trim() === name);
        if (!heading) return { text: '', links: [] };

        const nodes = [];
        for (let node = heading.nextElementSibling; node; node = node.nextElementSibling) {
          if (node.tagName === 'H5' || node.classList.contains('thread-tags')) break;
          nodes.push(node);
        }
        return {
          text: nodes.map((node) => node.textContent.trim()).filter(Boolean).join('\n'),
          links: nodes.flatMap((node) =>
            [...node.querySelectorAll('a[href]')].map((anchor) => anchor.href)
          )
        };
      };

      return {
        download: readSection('下载'),
        extractionCode: readSection('提取码'),
        backup: readSection('备份')
      };
    });

    return parseHifitiResourceSections({
      download: sections.download.links,
      extractionCode: sections.extractionCode.text,
      backup: sections.backup.text
    }).map((resource) => ({ ...resource, source }));
  }
}
