# lulucute-plugins

独立维护 [lulucute](https://github.com/westmelon/lulucute) 的网站与网盘插件。主项目通过 Git 下载指定版本并安装到本地；插件在服务启动时按配置加载。本仓库为私有仓库，访问需要 GitHub 仓库权限和本机 Git 凭据或 SSH 密钥。

## 插件

| ID | 名称 | 能力 |
| --- | --- | --- |
| `bilibili` | Bilibili | 视频解析、指定/全部分 P、UP 合集、增量同步、登录、aria2 传输和 FFmpeg 合并 |
| `afdian` | 爱发电 | 专辑与动态列表、视频/音频/附件、增量同步 |
| `hifiti` | HiFiTi | 登录检测、回复解锁、提取链接与提取码 |
| `baidu` | 百度网盘 | 提取码、官方下载入口、浏览器或官方客户端下载监控 |
| `lanzou` | 蓝奏云 | 提取码、临时直链解析 |

每个包位于 `plugins/<id>/`，包含 `plugin.json` 和 JavaScript 入口。API 版本为 `1`；运行时代码没有主项目源码的相对路径依赖，也没有 npm 依赖。通用能力由工厂的 `services` 注入，专属选项来自 `config.plugins.options[id]`。

具体配置、登录、下载流程与限制见 [插件使用与实现说明](docs/usage.md)。

## 页面发现

仓库遵循 [插件仓库规范 v1](docs/plugin-repository.md)，根目录 `repository.json` 列出可安装插件。

在主项目页面点击拼图图标，输入 `https://github.com/westmelon/lulucute-plugins.git`、`git@github.com:westmelon/lulucute-plugins.git` 或本仓库绝对路径即可自动列出插件；留空版本读取默认分支，也可填 `main` 或 commit。选择插件安装，安装内容固定到读取列表时的 commit。安装后启用仍需重启服务。

## 安装与更新

在主项目目录执行：

```bash
npm run plugins -- install bilibili --repository https://github.com/westmelon/lulucute-plugins.git --ref main --config config.json
```

其他插件替换 ID 即可。安装到 `plugins.directories` 的第一个目录，将 ID 加入 `plugins.enabled` 后重启服务。主项目的新示例配置使用空启用列表，可以先打开页面安装并配置启用；启用但未安装的 ID 会阻止服务启动。

私有仓库使用本机 Git 凭据或 SSH 密钥，安装器不会弹出登录提示；安装前应确认 `git ls-remote <仓库地址>` 可正常执行。不支持把访问令牌直接写入地址。插件执行权限与主项目相同，安装校验不能替代代码审查。

```bash
# 先停止主项目服务
npm run plugins -- update bilibili --ref main --config config.json
npm run plugins -- rollback bilibili --config config.json
```

更新命令复用已安装插件的仓库地址；历史重置后，使用旧标签的安装记录需显式指定 `--ref main` 更新。回滚恢复最近一次本地备份。安装记录包含实际 commit，原启用顺序、选项、任务队列和登录资料由主项目继续维护。Git 获取指定版本的仓库内容，只把选中的插件包安装到扫描目录。

## 开发与测试

Node.js 20+。独立解析与适配器单元测试不需要主项目：

```bash
npm test
```

跨仓库集成测试覆盖加载、配置兼容、队列指纹、合集增量同步、下载与合并。通过环境变量指定任意位置的主项目 checkout，不依赖两个仓库的相对位置；主项目需先安装 npm 依赖。FFmpeg 和 aria2 路径按本机实际位置填写：

```bash
RESOURCE_HUB_CORE=/absolute/path/to/lulucute \
BILIBILI_TEST_FFMPEG=/absolute/path/to/ffmpeg \
BILIBILI_TEST_ARIA2=/absolute/path/to/aria2c \
npm run test:integration
```

测试仅使用内存响应和本机 HTTP 服务，不访问真实站点、不使用账号 Cookie、不提交公开回复。

接口与配置见 [插件 API](docs/plugin-api.md)。新增插件时创建 `plugins/<id>/plugin.json` 和入口即可，不需要在核心增加站点名单。修改 URL 规范化规则前应验证既有队列和完成指纹兼容。

## 版本发布

当前仓库保留一个最新快照，不保留旧版本标签；可使用 `main` 或实际 commit 安装。安装器记录合集 commit，各插件可独立安装或更新，不要求其他插件同步升级。发布前运行单元测试和跨仓库测试，提交改动后创建新的版本标签，不移动已发布标签。更新有破坏性接口变化时应同步主项目的 API 版本与迁移说明。
