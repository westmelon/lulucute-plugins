export class LanzouProviderAdapter {
  match(resource) {
    return resource.provider === 'lanzou'
      || ((!resource.provider || resource.provider === 'direct')
        && /(^|\.)lanzou[a-z]*\.com$/i.test(new URL(resource.url).hostname));
  }

  async resolve(context, resource, { signal } = {}) {
    signal?.throwIfAborted();
    const page = await context.newPage();
    try {
      await page.goto(resource.url, { waitUntil: 'domcontentloaded' });
      signal?.throwIfAborted();
      const passwordInput = page.locator('#pwd');
      if (await passwordInput.count()) {
        if (!resource.code) throw new Error('Lanzou password is required');
        await passwordInput.fill(resource.code);
        await page.locator('.passwddiv-btn').click();
      }

      await page.waitForFunction(
        () => [...document.querySelectorAll('a[href]')]
          .some((anchor) => anchor.textContent.trim() === '下载' && anchor.href.startsWith('http')),
        null,
        { timeout: 15_000 }
      );
      signal?.throwIfAborted();

      const result = await page.evaluate(() => {
        const link = [...document.querySelectorAll('a[href]')]
          .find((anchor) => anchor.textContent.trim() === '下载' && anchor.href.startsWith('http'));
        return {
          directUrl: link.href,
          filename: document.title && document.title !== '文件' ? document.title : null,
          userAgent: navigator.userAgent
        };
      });

      return {
        ...resource,
        directUrl: result.directUrl,
        filename: result.filename,
        headers: {
          Referer: resource.url,
          'User-Agent': result.userAgent
        }
      };
    } finally {
      await page.close().catch(() => {});
    }
  }
}
