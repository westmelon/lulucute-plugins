import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function coreModule(relative) {
  const root = process.env.RESOURCE_HUB_CORE;
  if (!root) throw new Error('集成测试需要设置 RESOURCE_HUB_CORE 为主项目绝对路径');
  return import(pathToFileURL(path.resolve(root, relative)).href);
}
