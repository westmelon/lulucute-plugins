# 插件使用与实现说明

本文记录 lulucute-plugins 中各站点插件的使用、配置和实现行为。通用安装、队列和本地服务说明见 [主项目](https://github.com/westmelon/lulucute)，接口见 [插件 API](plugin-api.md)。以下命令均在主项目目录执行；登录命令应在本地服务关闭且 `browser.headless` 为 `false` 时运行。

## 安装与配置

仓库为私有仓库，需要 GitHub 访问权限及本机 Git 凭据或 SSH 密钥。HTTPS 地址也可替换为 `git@github.com:westmelon/lulucute-plugins.git`。当前版本使用 `main`；安装器会记录实际 commit，也可以直接指定 commit 固定内容。

```bash
npm run plugins -- install bilibili --repository https://github.com/westmelon/lulucute-plugins.git --ref main --config config.json
npm run plugins -- install afdian --repository https://github.com/westmelon/lulucute-plugins.git --ref main --config config.json
npm run plugins -- install hifiti --repository https://github.com/westmelon/lulucute-plugins.git --ref main --config config.json
npm run plugins -- install baidu --repository https://github.com/westmelon/lulucute-plugins.git --ref main --config config.json
npm run plugins -- install lanzou --repository https://github.com/westmelon/lulucute-plugins.git --ref main --config config.json
```

只启用已经安装且需要使用的插件，修改配置后重启本地服务：

```json
{
  "plugins": {
    "directories": ["./plugins"],
    "enabled": ["bilibili", "afdian", "hifiti", "baidu", "lanzou"],
    "options": {
      "bilibili": { "ffmpegPath": "ffmpeg", "aria2Path": "aria2c" },
      "baidu": { "timeoutMs": 3600000, "pollIntervalMs": 2000, "quietPeriodMs": 15000 }
    }
  }
}
```

`plugins.options` 优先于旧的 `workflow.bilibiliFfmpegPath`、`workflow.bilibiliAria2Path` 和 `workflow.baiduDownload*`。既有队列格式、完成指纹、登录资料与归档文件保持兼容。

旧安装记录若使用已删除的 `v0.1.0` 或 `v0.2.0`，更新时显式指定新 ref，例如：

```bash
npm run plugins -- update bilibili --ref main --config config.json
```

## HiFiTi

检测登录状态，按配置回复解锁，提取下载链接和提取码，再交给已启用的网盘插件处理。首次登录：

```bash
npm start -- --config config.json --login https://www.hifiti.com/user-login.htm
```

在打开的 Chrome 中登录后按 `Ctrl+C`，后续复用 `.data/browser-profile` 中的登录态，不共享日常 Chrome 的登录状态。扩展侧边栏可识别当前帖子并加入队列。

```bash
# 预检：不回复、不解析网盘、不下载
npm start -- --config config.json --url https://www.hifiti.com/thread-1228.htm --dry-run
# 自动处理；autoReply 开启时会公开回复
npm start -- --config config.json --url https://www.hifiti.com/thread-1228.htm
```

网站插件只解析资源链接和提取码，新增网盘由下载插件负责，无需修改 HiFiTi 的解析代码。

## 爱发电

读取已登录账号可访问的专辑或 `post/get-list` 动态列表，下载视频、音频和附件。首次使用前打开专辑登录：

```bash
npm start -- --config config.json --login https://afdian.com/album/93148dc0ad3811f0a32e52540025c377
```

在下载器 Chrome 中完成登录后按 `Ctrl+C`，与其他网站插件复用持久化浏览器资料目录。通过侧边栏或 `--url` 提交专辑或动态接口。动态接口的当前分页游标会被忽略，用户、方案等筛选条件保留，因此重复提交同一动态列表只同步新增内容。账号只能下载其实际有权限访问的资源。

再次提交已完成专辑会检查全部分页，只下载新增的视频、音频和附件。专辑 ID、帖子 ID 和媒体类型组成稳定资源标识，每个文件下载前刷新带时效的真实地址。成功资源以 SHA-256 指纹记入 `.data/task-queue.json`，不保存文件路径、提取码或签名 URL。

移动文件或删除任务不会清除下载索引；删除文件、替换旧帖中的同类媒体不会自动触发重新下载。

## Bilibili 视频与合集

实现参考 [yutto](https://github.com/yutto-dev/yutto) 的普通投稿信息接口、播放流参数及 FFmpeg 合并流程，不需要安装 Python 或 yutto。视频信息优先读取投稿网页已提供的数据；信息接口返回 HTTP 412 时也会尝试从对应投稿网页读取。

需要可正常运行的 FFmpeg 和 aria2；macOS 可使用 `brew install ffmpeg aria2`，Windows/Linux 安装对应工具并加入 PATH。先执行 `ffmpeg -version` 和 `aria2c --version` 确认安装有效。侧边栏自动启动的服务可能没有终端的 PATH，可在 `config.json` 的 `plugins.options.bilibili` 中填写完整路径：

```json
{
  "ffmpegPath": "/opt/homebrew/bin/ffmpeg",
  "aria2Path": "/opt/homebrew/bin/aria2c"
}
```

默认值分别为 `ffmpeg` 和 `aria2c`。工具缺失或无法启动时，任务显示“需处理”；修复后重试。登录和解析继续使用 Chrome，Bilibili 音视频文件由 aria2 传输，再交给 FFmpeg 合并。下载按当前账号实际可访问的最高画质选择，同画质优先 AVC，音频优先常规最高码率，不转码。未登录账号通常只能取得较低画质。

在插件中切换到 Bilibili 页面，点击“登录 Bilibili”，在弹出的专用 Chrome 窗口中手动登录，然后回到插件点击“完成登录”。登录期间新任务等待，服务不会因空闲自动退出；任务运行中暂不允许打开登录窗口。直接关闭登录窗口也会恢复队列。登录使用下载器资料目录，后续下载复用会话，后台静默运行设置保持原样。“完成登录”只保存并关闭窗口，不代表已确认账号登录成功。

也可以在本地服务关闭且 `browser.headless` 为 `false` 时通过命令行登录：

```bash
npm start -- --config config.json --login https://www.bilibili.com/
```

在打开的下载器 Chrome 中完成登录后按 `Ctrl+C`；它使用独立资料目录，不共享日常 Chrome 的登录状态。只下载第 1 P，或通过 `?p=N` 指定分 P：

```bash
npm start -- --config config.json --url 'https://www.bilibili.com/video/BV1CTMHziEaB/'
npm start -- --config config.json --url 'https://www.bilibili.com/video/BV1CTMHziEaB/?p=2'
```

第二条用于演示分 P 参数，实际视频必须存在所指定的分 P。`av` 链接和跳转到支持页面的 `b23.tv` 短链也可以直接提交。

下载多 P 投稿的全部内容时，在插件点击“下载全部分 P（一个任务）”，或提交 `https://www.bilibili.com/video/BV1wM4y1g7Lp/?p=all`。队列只显示一个任务，内部按分 P 顺序下载并显示整体进度及当前音视频流的字节数、速度；重试或再次提交已完成任务时跳过已有完成记录。`p=all` 是下载器参数，访问官方网页时使用第 1 P。多 P 文件使用 `分P标题.mp4`，不再拼接投稿名称或 `P几`；缺少分 P 标题时使用视频标题，单 P 投稿使用视频标题。同名文件自动添加 `(1)`、`(2)` 等后缀，已归档文件不自动改名。

aria2 接收主地址及全部备用 CDN，每条音视频流最多使用 4 个连接，同一服务器最多 2 个连接，最小拆分单位为 1 MiB。采用 adaptive 镜像选择；开启每连接 8 KiB/s 的低速保护、10 秒连接超时、15 秒网络超时及最多 3 次尝试。使用系统 DNS 解析，避免 aria2 的异步解析器与本机 DNS 配置不一致。低速连接由 aria2 按其速度统计窗口判断并断开，不因偶尔收到数据而无限等待。插件约每秒更新字节进度；音视频依次下载，总并发保持在 4 个连接以内。

并发传输因线路持续低速而失败时，保留分段并降级为单连接续传一次，最低速度降至 1 KiB/s；仍保留连接和断流超时。所有线路都较慢时允许继续完成，插件会显示实际速度。

失败或取消时，已下载媒体和 aria2 续传记录保留在归档目录的 `.bilibili-*` 隐藏目录；重试相同视频和音视频流时继续下载，成功合并后自动清理。画质或音视频流标识变化时使用新的临时目录。已签名的 CDN 地址仅通过本机接口传入 aria2，不保存到队列或命令行；临时接口仅监听本机并使用随机令牌，退出时清理。

支持以下 UP 主合集链接（用实际 UP 主 ID、合集 ID 替换示例数字）：

```text
https://space.bilibili.com/123/lists/456?type=season
https://space.bilibili.com/123/channel/collectiondetail?sid=456
https://space.bilibili.com/123/favlist?fid=456&ftype=collect
```

使用同一个 `--url` 命令或侧边栏提交合集。程序按合集分页顺序下载所有视频及各自全部分 P，归档为 `下载根目录/Bilibili/UP-ID/合集名称/序号 - 分P标题.mp4`；单 P 投稿使用 `序号 - 视频标题.mp4`。无法访问的条目会报告失败，其他视频继续下载；失败任务可在问题解决后重试。

重复提交已完成合集会重新检查分页，只下载尚未记录完成的视频分 P。合集和单视频以 BV 号与分 P 共享完成索引，分享追踪参数不会导致重复下载。删除任务后仍保留完成索引；删除文件不会自动触发重新下载，同一分 P 的内容替换也不会自动重新下载。

普通视频链接默认只下载指定分 P；全部分 P 使用上述插件按钮或 `p=all`。UP 主合集使用上面的合集链接。当前不支持 `type=series` 视频列表、普通收藏夹、番剧、课程、直播、DRM、字幕或弹幕；验证码、登录失效、权限不足和 HTTP 412 风控需要在官方页面处理后重试。

## 百度网盘

自动填入上游资源的提取码、选择全部项目，依次尝试下载、高速下载（推荐）及打开官方客户端入口。需要提取码但上游未提供，或提交后未解锁、下载按钮不可用时，任务要求人工处理。

支持浏览器下载和百度网盘官方客户端。浏览器触发下载事件时将文件保存到当前任务归档目录；客户端模式监控 `downloadRoot`，完成后自动归档。连接设置中的“后台静默运行”只控制自动化浏览器，不控制官方客户端窗口。

客户端默认下载目录必须与 `downloadRoot` 相同。监控器在开始前记录根目录基线，之后识别新增的非隐藏文件或目录，排除当前归档目标的顶层目录。所有候选没有临时文件或不安全对象，且文件大小、修改时间及目录内容在静默期保持稳定后，一起移动到任务目录；支持多个完成项。已有基线中的项目不会归档。监控按目录变化识别本次下载，运行期间不要同时向该根目录启动无关下载，以免误归档。

登录、验证码和风控仍由官方页面处理。自动定位下载按钮失败时，终端列出可见控件并继续监控；在打开的页面手动发起下载后仍可完成归档。默认最多等待 60 分钟，超时要求人工处理。推荐配置：

```json
{
  "plugins": {
    "options": {
      "baidu": {
        "timeoutMs": 3600000,
        "pollIntervalMs": 2000,
        "quietPeriodMs": 15000
      }
    }
  }
}
```

三项均为正整数毫秒数，`quietPeriodMs` 必须小于 `timeoutMs`。仍兼容 `workflow.baiduDownloadTimeoutMs`、`workflow.baiduDownloadPollIntervalMs`、`workflow.baiduDownloadQuietPeriodMs`，但新的插件选项优先。

## 蓝奏云

自动填密码、解析临时直链，交给核心流式下载。分享页存在密码框时，密码来自上游资源的 `code`；缺少密码会失败。插件在浏览器中等待下载链接，读取页面标题作为可用文件名，并将分享页 `Referer` 和浏览器 `User-Agent` 随直链交给下载器。临时链接在当前任务中解析，不应作为稳定资源标识保存。
