import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { BILIBILI_HEADERS, BilibiliApiError, requestBilibiliJson } from './common.mjs';

function runFfmpeg(executable, args, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let failure;
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4_096); });
    child.on('error', (error) => { failure = error; });
    child.on('close', (code) => {
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`FFmpeg 合并失败 (${code})：${stderr}`));
      else resolve();
    });
  });
}

function streamUrl(stream) {
  return stream.baseUrl || stream.base_url || stream.url;
}

export function selectBilibiliStreams(data) {
  if (data.is_drm) throw new Error('暂不支持 DRM 视频');
  if (data.dash) {
    const videos = (data.dash.video || []).filter(streamUrl).sort((a, b) =>
      b.id - a.id || Number(b.codecid === 7) - Number(a.codecid === 7) || b.bandwidth - a.bandwidth);
    const audios = (data.dash.audio || []).filter(streamUrl).sort((a, b) =>
      b.bandwidth - a.bandwidth || b.id - a.id);
    if (!videos.length) throw new Error('Bilibili 未返回可下载的视频流，请检查访问权限');
    return { type: 'dash', video: videos[0], audio: audios[0] || null };
  }
  if (Array.isArray(data.durl) && data.durl.length && data.durl.every(streamUrl)) {
    return { type: 'segments', segments: [...data.durl].sort((a, b) => a.order - b.order) };
  }
  throw new Error('Bilibili 未返回可下载的音视频流，请检查登录及访问权限');
}

async function downloadStream(downloader, stream, options) {
  const urls = [...new Set([streamUrl(stream), ...(stream.backupUrl || stream.backup_url || [])])];
  return downloader.download({ ...options, urls });
}

export class BilibiliProviderAdapter {
  constructor({ ffmpegPath = 'ffmpeg', aria2Path = 'aria2c', services,
    downloader = new services.Aria2Downloader({ executable: aria2Path }) }) {
    this.ffmpegPath = ffmpegPath;
    this.downloader = downloader;
    this.allocateAvailablePath = services.allocateAvailablePath;
    this.sanitizeSegment = services.sanitizeSegment;
  }

  match(resource) {
    return resource.provider === 'bilibili';
  }

  async resolve(context, resource, { directory, signal, onProgress = async () => {} } = {}) {
    signal?.throwIfAborted();
    if (resource.inspectionError) throw new Error(resource.inspectionError);
    try {
      await runFfmpeg(this.ffmpegPath, ['-version'], signal);
    } catch (error) {
      signal?.throwIfAborted();
      return { status: 'action-required', resource,
        reason: error.code === 'ENOENT' ? 'bilibili-ffmpeg-missing' : 'bilibili-ffmpeg-unavailable',
        message: `FFmpeg 无法运行，请安装或修复，并在 plugins.options.bilibili.ffmpegPath 设置完整路径后重试：${error.message}` };
    }

    try {
      await this.downloader.checkAvailable?.(signal);
    } catch (error) {
      signal?.throwIfAborted();
      return { status: 'action-required', resource,
        reason: error.code === 'ENOENT' ? 'bilibili-aria2-missing' : 'bilibili-aria2-unavailable',
        message: 'aria2 无法运行，请安装 aria2，并在 plugins.options.bilibili.aria2Path 设置完整路径后重试' };
    }

    let data;
    try {
      // 同 yutto 的普通投稿接口，申请所有画质；只选择当前账号实际返回的流。
      data = await requestBilibiliJson(context, '/x/player/playurl', {
        bvid: resource.bvid, cid: resource.cid, qn: 127, fnver: 0, fnval: 4048, fourk: 1
      }, { signal });
    } catch (error) {
      if (!(error instanceof BilibiliApiError)
        || ![-101, -403, -352, 401, 403, 412, 62012].includes(error.code)) throw error;
      return { status: 'action-required', reason: 'bilibili-access-required',
        message: error.message, resource };
    }
    const streams = selectBilibiliStreams(data);
    await mkdir(directory, { recursive: true });
    const identity = createHash('sha256').update(JSON.stringify({
      bvid: resource.bvid, cid: resource.cid, type: streams.type,
      video: streams.video && [streams.video.id, streams.video.codecid, new URL(streamUrl(streams.video)).pathname],
      audio: streams.audio && [streams.audio.id, new URL(streamUrl(streams.audio)).pathname],
      segments: streams.segments?.map((stream) => new URL(streamUrl(stream)).pathname)
    })).digest('hex').slice(0, 24);
    const temporary = path.join(directory, `.bilibili-${identity}`);
    await mkdir(temporary, { recursive: true });
    let completed = false;
    const output = path.join(temporary, 'output.mp4');
    try {
      const streamCount = streams.type === 'dash' ? (streams.audio ? 2 : 1) : streams.segments.length;
      const options = { directory: temporary, headers: BILIBILI_HEADERS, signal };
      const progressFor = (stream, name) => async (progress) => onProgress({
        ...progress, stream, streamCount, streamName: name
      });
      const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n'];
      if (streams.type === 'dash') {
        const video = await downloadStream(this.downloader, streams.video,
          { ...options, filename: 'video.m4s', onProgress: progressFor(1, '视频') });
        args.push('-i', video.path);
        if (streams.audio) {
          const audio = await downloadStream(this.downloader, streams.audio,
            { ...options, filename: 'audio.m4s', onProgress: progressFor(2, '音频') });
          args.push('-i', audio.path, '-map', '0:v:0', '-map', '1:a:0');
        } else {
          args.push('-map', '0:v:0');
        }
      } else {
        for (let index = 0; index < streams.segments.length; index += 1) {
          const segment = await downloadStream(this.downloader, streams.segments[index],
            { ...options, filename: `segment-${index}.flv`, onProgress: progressFor(index + 1, `片段 ${index + 1}`) });
          if (streams.segments.length === 1) args.push('-i', segment.path);
        }
        if (streams.segments.length > 1) {
          // 多段旧格式需要按时间拼接，使用 concat demuxer 以保持无转码合并。
          const list = path.join(temporary, 'segments.txt');
          await writeFile(list, streams.segments.map((_item, index) => `file 'segment-${index}.flv'`).join('\n'));
          args.push('-f', 'concat', '-safe', '1', '-i', list);
        }
      }
      await onProgress({ stream: streamCount, streamCount, streamName: '合并中', speed: 0 });
      await rm(output, { force: true });
      args.push('-c', 'copy', '-movflags', '+faststart', output);
      await runFfmpeg(this.ffmpegPath, args, signal);
      signal?.throwIfAborted();
      const bytes = (await stat(output)).size;
      if (!bytes) throw new Error('FFmpeg 生成了空的视频文件');
      const stem = this.sanitizeSegment(String(resource.filename || resource.bvid).replace(/\.mp4$/i, '')).slice(0, 95);
      const finalPath = await this.allocateAvailablePath(directory, `${stem}.mp4`);
      await rename(output, finalPath);
      completed = true;
      return { status: 'downloaded', resource,
        download: { path: finalPath, bytes, method: 'bilibili-ffmpeg', quality: streams.video?.id || data.quality } };
    } catch (error) {
      signal?.throwIfAborted();
      console.error(`[resource-downloader] Bilibili ${resource.bvid} CID ${resource.cid}: ${error.message}`);
      throw error;
    } finally {
      if (completed) await rm(temporary, { recursive: true, force: true });
      else await rm(output, { force: true });
    }
  }
}
