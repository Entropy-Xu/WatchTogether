/**
 * yt-dlp 封装模块
 * 支持 1000+ 网站视频解析
 */

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const execAsync = promisify(exec);

// yt-dlp 可执行文件路径（优先使用系统 PATH）
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';

// 默认配置
const DEFAULT_OPTIONS = {
  timeout: 120000,       // 120秒超时
  maxFileSize: '2G',     // 最大文件大小
};

/**
 * 检查 yt-dlp 是否已安装
 */
async function isAvailable() {
  try {
    const { stdout } = await execAsync(`${YTDLP_PATH} --version`);
    console.log(`[yt-dlp] 版本: ${stdout.trim()}`);
    return { available: true, version: stdout.trim() };
  } catch (err) {
    console.warn('[yt-dlp] 未安装或不在 PATH 中:', err.message);
    return { available: false, error: err.message };
  }
}

/**
 * 获取视频信息（不下载）
 */
async function getInfo(url, options = {}) {
  const args = [
    '--dump-json',
    '--no-download',
    '--no-warnings',
    '--no-playlist',  // 不处理播放列表
    url
  ];

  return new Promise((resolve, reject) => {
    const timeout = options.timeout || DEFAULT_OPTIONS.timeout;
    let timeoutId;

    const ytdlp = spawn(YTDLP_PATH, args);

    let stdout = '';
    let stderr = '';

    ytdlp.stdout.on('data', (data) => stdout += data);
    ytdlp.stderr.on('data', (data) => stderr += data);

    timeoutId = setTimeout(() => {
      ytdlp.kill('SIGTERM');
      reject(new Error('获取视频信息超时'));
    }, timeout);

    ytdlp.on('close', (code) => {
      clearTimeout(timeoutId);

      if (code === 0) {
        try {
          const info = JSON.parse(stdout);
          resolve({
            title: info.title || '未知标题',
            description: info.description || '',
            duration: info.duration || 0,
            thumbnail: info.thumbnail || '',
            uploader: info.uploader || info.channel || '',
            uploadDate: info.upload_date || '',
            viewCount: info.view_count || 0,
            formats: (info.formats || []).map(f => ({
              formatId: f.format_id,
              ext: f.ext,
              quality: f.quality,
              resolution: f.resolution || (f.height ? `${f.width}x${f.height}` : null),
              height: f.height,
              filesize: f.filesize || f.filesize_approx,
              vcodec: f.vcodec,
              acodec: f.acodec,
              url: f.url,
              hasVideo: f.vcodec !== 'none',
              hasAudio: f.acodec !== 'none'
            })),
            bestFormat: selectBestFormat(info.formats),
            webpage_url: info.webpage_url,
            extractor: info.extractor,
            extractor_key: info.extractor_key
          });
        } catch (e) {
          reject(new Error(`解析视频信息失败: ${e.message}`));
        }
      } else {
        const errorMsg = stderr || `yt-dlp 退出码: ${code}`;
        // 解析常见错误
        if (errorMsg.includes('Video unavailable')) {
          reject(new Error('视频不可用或已被删除'));
        } else if (errorMsg.includes('Private video')) {
          reject(new Error('这是私密视频，无法访问'));
        } else if (errorMsg.includes('Sign in')) {
          reject(new Error('此视频需要登录才能观看'));
        } else if (errorMsg.includes('not a valid URL')) {
          reject(new Error('无效的视频链接'));
        } else if (errorMsg.includes('Unsupported URL')) {
          reject(new Error('不支持此网站或链接格式'));
        } else if (errorMsg.includes('Cloudflare') || errorMsg.includes('403') || errorMsg.includes('anti-bot')) {
          reject(new Error('此网站有 Cloudflare 保护，无法自动解析。请在浏览器中打开视频页面，按 F12 打开开发者工具，在 Network 标签页中筛选 "m3u8"，找到视频地址后直接粘贴到视频链接输入框'));
        } else {
          reject(new Error(errorMsg.slice(0, 200)));
        }
      }
    });

    ytdlp.on('error', (err) => {
      clearTimeout(timeoutId);
      if (err.code === 'ENOENT') {
        reject(new Error('yt-dlp 未安装，请先安装: brew install yt-dlp (macOS) 或 apt install yt-dlp (Linux)'));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * 选择最佳格式（优先有音视频的 mp4）
 */
function selectBestFormat(formats) {
  if (!formats || formats.length === 0) return null;

  // 优先选择有音视频的 mp4 格式
  const mp4WithAudio = formats.filter(f =>
    f.ext === 'mp4' &&
    f.vcodec !== 'none' &&
    f.acodec !== 'none'
  ).sort((a, b) => (b.height || 0) - (a.height || 0));

  if (mp4WithAudio.length > 0) {
    return mp4WithAudio[0];
  }

  // 其次选择有音视频的 webm
  const webmWithAudio = formats.filter(f =>
    f.ext === 'webm' &&
    f.vcodec !== 'none' &&
    f.acodec !== 'none'
  ).sort((a, b) => (b.height || 0) - (a.height || 0));

  if (webmWithAudio.length > 0) {
    return webmWithAudio[0];
  }

  // 否则选择最高质量的视频格式
  const videoFormats = formats.filter(f => f.vcodec !== 'none')
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  return videoFormats[0] || formats[0];
}

/**
 * 提取直接播放地址（流式，不下载）
 */
async function extractUrl(url, options = {}) {
  const quality = options.quality || 'best[ext=mp4]/best';

  const args = [
    '-f', quality,
    '-g',  // 只获取 URL，不下载
    '--no-warnings',
    '--no-playlist',
    url
  ];

  try {
    const { stdout, stderr } = await execAsync(
      `${YTDLP_PATH} ${args.map(a => `"${a}"`).join(' ')}`,
      { timeout: DEFAULT_OPTIONS.timeout }
    );

    const urls = stdout.trim().split('\n').filter(Boolean);

    if (urls.length === 0) {
      throw new Error('无法提取视频地址');
    }

    return {
      type: urls.length > 1 ? 'dash' : 'direct',
      videoUrl: urls[0],
      audioUrl: urls[1] || null
    };
  } catch (err) {
    if (err.killed) {
      throw new Error('提取视频地址超时');
    }
    throw err;
  }
}

/**
 * 下载视频到本地（带进度回调）
 */
async function download(url, options = {}) {
  const {
    outputDir,
    filename,
    quality = 'best[ext=mp4]/best',
    onProgress
  } = options;

  // 生成唯一文件名
  const outputFilename = filename || `video_${Date.now()}.%(ext)s`;
  const outputTemplate = path.join(outputDir, outputFilename);

  const args = [
    '-f', quality,
    '--merge-output-format', 'mp4',
    '-o', outputTemplate,
    '--newline',  // 进度输出换行
    '--no-warnings',
    '--no-playlist',
    '--no-mtime',  // 不修改文件时间
    url
  ];

  return new Promise((resolve, reject) => {
    const ytdlp = spawn(YTDLP_PATH, args);
    let outputPath = '';
    let lastProgress = 0;

    ytdlp.stdout.on('data', (data) => {
      const line = data.toString();

      // 解析下载进度
      const progressMatch = line.match(/\[download\]\s+(\d+\.?\d*)%/);
      if (progressMatch && onProgress) {
        const progress = parseFloat(progressMatch[1]);
        // 避免频繁回调
        if (progress - lastProgress >= 1 || progress >= 100) {
          lastProgress = progress;
          onProgress({
            stage: 'downloading',
            progress: Math.min(progress, 95),  // 保留空间给合并阶段
            message: `下载中... ${progress.toFixed(1)}%`
          });
        }
      }

      // 解析输出文件路径
      const destMatch = line.match(/\[download\] Destination: (.+)/);
      if (destMatch) {
        outputPath = destMatch[1].trim();
      }

      // 已存在文件
      const existsMatch = line.match(/\[download\] (.+) has already been downloaded/);
      if (existsMatch) {
        outputPath = existsMatch[1].trim();
      }

      // 合并阶段
      if (line.includes('[Merger]') || line.includes('[ffmpeg]')) {
        onProgress?.({
          stage: 'merging',
          progress: 96,
          message: '正在合并音视频...'
        });
      }
    });

    ytdlp.stderr.on('data', (data) => {
      const line = data.toString();
      console.error('[yt-dlp stderr]', line);

      // 检测错误
      if (line.includes('ERROR')) {
        onProgress?.({
          stage: 'error',
          progress: 0,
          message: line.slice(0, 100)
        });
      }
    });

    ytdlp.on('close', (code) => {
      if (code === 0) {
        // 找到输出文件
        if (!outputPath) {
          // 尝试查找生成的文件
          const files = fs.readdirSync(outputDir)
            .filter(f => f.startsWith('video_') && f.endsWith('.mp4'))
            .sort()
            .reverse();
          if (files.length > 0) {
            outputPath = path.join(outputDir, files[0]);
          }
        }

        onProgress?.({
          stage: 'complete',
          progress: 100,
          message: '下载完成'
        });

        resolve({
          success: true,
          outputPath,
          filename: path.basename(outputPath),
          url: `/uploads/${path.basename(outputPath)}`
        });
      } else {
        reject(new Error(`下载失败，退出码: ${code}`));
      }
    });

    ytdlp.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('yt-dlp 未安装'));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * 完整解析流程（获取信息 + 提取/下载）
 */
async function extract(url, options = {}) {
  const { onProgress, outputDir, forceDownload } = options;

  onProgress?.({
    stage: 'analyzing',
    progress: 5,
    message: '正在分析网页...'
  });

  // 1. 获取视频信息
  const info = await getInfo(url, options);

  onProgress?.({
    stage: 'analyzing',
    progress: 20,
    message: `找到视频: ${info.title.slice(0, 30)}...`
  });

  // 2. 尝试直接提取播放地址
  // YouTube 视频必须下载（CDN URL 绑定 IP 且有过期间隔，代理难以处理）
  const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');

  if (!forceDownload && !isYouTube) {
    try {
      onProgress?.({
        stage: 'extracting',
        progress: 30,
        message: '尝试提取直接播放地址...'
      });

      const extracted = await extractUrl(url, options);

      // 检测是否是可直接播放的格式
      const videoUrl = extracted.videoUrl;
      const isDirectPlayable = videoUrl &&
        !videoUrl.includes('.m3u8') &&
        !videoUrl.includes('.mpd') &&
        !videoUrl.includes('manifest');

      if (isDirectPlayable) {
        onProgress?.({
          stage: 'complete',
          progress: 100,
          message: '解析完成'
        });

        // 如果有分离的音频 URL（如 YouTube），使用 MSE 模式
        if (extracted.audioUrl) {
          return {
            type: 'mse',
            videoUrl: videoUrl,
            audioUrl: extracted.audioUrl,
            title: info.title,
            duration: info.duration,
            thumbnail: info.thumbnail,
            needsProxy: true  // YouTube 等需要代理
          };
        }

        return {
          type: 'direct',
          url: videoUrl,
          audioUrl: extracted.audioUrl,
          title: info.title,
          duration: info.duration,
          thumbnail: info.thumbnail,
          needsProxy: true  // 大多数情况需要代理
        };
      }
    } catch (err) {
      console.log('[yt-dlp] 直接提取失败，将下载视频:', err.message);
    }
  }

  // 3. 需要下载的情况
  if (!outputDir) {
    throw new Error('需要下载视频但未指定输出目录');
  }

  onProgress?.({
    stage: 'downloading',
    progress: 35,
    message: '开始下载视频...'
  });

  const result = await download(url, {
    ...options,
    onProgress: (p) => {
      // 映射进度到 35-100
      const mappedProgress = 35 + (p.progress * 0.65);
      onProgress?.({
        ...p,
        progress: Math.round(mappedProgress)
      });
    }
  });

  return {
    type: 'local',
    url: result.url,
    filename: result.filename,
    title: info.title,
    duration: info.duration,
    thumbnail: info.thumbnail
  };
}

/**
 * 更新 yt-dlp
 */
async function update() {
  try {
    const { stdout, stderr } = await execAsync(`${YTDLP_PATH} -U`, {
      timeout: 60000
    });
    return {
      success: true,
      message: stdout || stderr
    };
  } catch (err) {
    return {
      success: false,
      message: err.message
    };
  }
}

module.exports = {
  isAvailable,
  getInfo,
  extractUrl,
  download,
  extract,
  update
};
