import { BaiduProviderAdapter } from './provider.mjs';

export function createAdapter({ config, services }) {
  const options = config.plugins?.options?.baidu || {};
  const timeoutMs = options.timeoutMs ?? config.workflow?.baiduDownloadTimeoutMs ?? 3_600_000;
  const pollIntervalMs = options.pollIntervalMs ?? config.workflow?.baiduDownloadPollIntervalMs ?? 2_000;
  const quietPeriodMs = options.quietPeriodMs ?? config.workflow?.baiduDownloadQuietPeriodMs ?? 15_000;
  for (const [name, value] of Object.entries({ timeoutMs, pollIntervalMs, quietPeriodMs })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Baidu ${name} must be a positive integer`);
  }
  if (quietPeriodMs >= timeoutMs) throw new Error('Baidu quietPeriodMs must be less than timeoutMs');
  return new BaiduProviderAdapter({ services, monitor: new services.ExternalDownloadMonitor({
    root: config.downloadRoot, timeoutMs, pollIntervalMs, quietPeriodMs
  }) });
}
