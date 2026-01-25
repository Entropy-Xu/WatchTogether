const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 创建上传目录
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// 配置 multer 文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // 生成唯一文件名
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  // 不设置文件大小限制
  fileFilter: (req, file, cb) => {
    // 允许的格式 (视频 + 字幕)
    const allowedTypes = /mp4|webm|mkv|avi|mov|m4v|ogg|ogv|flv|wmv|ts|srt|ass|ssa|sub|idx/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase().replace('.', ''));
    // 字幕文件的 mimetype 经常识别不准，所以主要靠扩展名
    const mimetype = file.mimetype.startsWith('video/') ||
      file.mimetype.includes('text/') ||
      file.mimetype.includes('app'); // application/x-subrip etc.

    if (extname) { // 主要信赖扩展名
      cb(null, true);
    } else {
      cb(new Error('不支持的文件格式'));
    }
  }
});

// 自定义 MIME 类型
const mimeTypes = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4', // MOV 使用 mp4 mime 类型可以更好兼容
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/x-mpegURL'
};

// JSON 请求体解析中间件
app.use(express.json());

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 上传文件服务 - 设置正确的 MIME 类型
app.use('/uploads', (req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  if (mimeTypes[ext]) {
    res.setHeader('Content-Type', mimeTypes[ext]);
  }
  // 允许范围请求（用于视频 seek）
  res.setHeader('Accept-Ranges', 'bytes');
  next();
}, express.static(uploadsDir));

// 存储房间信息
const rooms = new Map();

// 房间数据结构
class Room {
  constructor(id, hostName) {
    this.id = id;
    this.hostName = hostName;
    this.videoUrl = '';
    this.subtitleUrl = null; // 字幕 URL
    this.videoState = {
      isPlaying: false,
      currentTime: 0,
      playbackRate: 1,
      lastUpdated: Date.now()
    };
    this.users = new Map(); // socketId -> { name, joinedAt, isHost }
    this.messages = [];
    this.createdAt = Date.now();
    // 权限配置
    this.settings = {
      allowAllChangeVideo: false,     // 是否允许所有人更换视频
      allowAllChangeSubtitle: false,  // 是否允许所有人更换字幕
      allowAllControl: true            // 是否允许所有人控制播放
    };
    // 跟踪 B 站下载的文件（用于清理）
    this.bilibiliFiles = [];

    // 房主的用户 ID (用于重连恢复权限)
    this.hostUserId = null;
  }

  /**
   * 添加用户
   * @param {string} socketId - Socket 连接 ID
   * @param {string} name - 用户名
   * @param {string} userId - 用户唯一标识 (前端生成)
   */
  addUser(socketId, name, userId) {
    this.users.set(socketId, {
      name,
      userId, // 绑定 userId
      joinedAt: Date.now()
    });

    // 如果没有房主，或者该用户就是房主（重连）
    if (!this.hostUserId) {
      this.hostUserId = userId;
    }
  }

  /**
   * 移除用户
   * @param {string} socketId 
   */
  removeUser(socketId) {
    const user = this.users.get(socketId);
    this.users.delete(socketId);

    // 只有当房间彻底没人时，才重置房主
    // 这样房主刷新页面 (socketId 变了但 userId 没变) 回来后还是房主
    if (this.users.size === 0) {
      this.hostUserId = null;
    }
  }

  /**
   * 检查是否是房主
   */
  isHost(socketId) {
    const user = this.users.get(socketId);
    return user && user.userId === this.hostUserId;
  }

  getUserList() {
    const list = [];
    this.users.forEach((user, socketId) => {
      list.push({
        id: socketId,
        userId: user.userId, // 返回 userId 供前端判断
        name: user.name,
        isHost: user.userId === this.hostUserId
      });
    });
    return list;
  }

  addMessage(socketId, userName, text) {
    const message = {
      id: uuidv4(),
      userId: socketId,
      userName,
      text,
      timestamp: Date.now()
    };
    this.messages.push(message);
    // 只保留最近100条消息
    if (this.messages.length > 100) {
      this.messages.shift();
    }
    return message;
  }

  updateUserName(socketId, newName) {
    const user = this.users.get(socketId);
    if (user) {
      user.name = newName;
      return true;
    }
    return false;
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
  }

  transferHost(newHostSocketId) {
    const user = this.users.get(newHostSocketId);
    if (user) {
      this.hostUserId = user.userId;
      return true;
    }
    return false;
  }
}

// ============ 并行分片转码配置 ============
// 使用系统 PATH 中的 ffmpeg/ffprobe
const ffprobePath = 'ffprobe';
const ffmpegPath = 'ffmpeg';

// 每个分片的时长 (秒) - 5分钟
const SEGMENT_DURATION = 300;
// 最大并行进程数 (基于 CPU 核心数)
const MAX_PARALLEL_WORKERS = Math.max(2, Math.floor(os.cpus().length / 2));

console.log(`并行转码配置: 每片 ${SEGMENT_DURATION}s, 最大 ${MAX_PARALLEL_WORKERS} 并行进程`);

// ============ 转码进度追踪 ============
// 存储转码进度 { uploadId -> { filename, stage, progress, message, ... } }
const transcodeProgress = new Map();

/**
 * 发送转码进度到前端
 */
function emitProgress(uploadId, data) {
  const progressData = {
    uploadId,
    filename: data.filename || '',
    stage: data.stage || 'processing', // 'analyzing', 'transcoding', 'merging', 'complete', 'error'
    progress: data.progress || 0,       // 0-100
    message: data.message || '',
    segmentInfo: data.segmentInfo || null, // { current, total, completed }
    ...data
  };

  transcodeProgress.set(uploadId, progressData);

  // 广播给所有连接的客户端
  io.emit('transcode-progress', progressData);

  console.log(`[进度] ${uploadId}: ${progressData.stage} - ${progressData.progress}% - ${progressData.message}`);
}

/**
 * 获取视频时长 (秒)
 */
async function getVideoDuration(filePath) {
  const cmd = `${ffprobePath} -v error -show_entries format=duration -of csv=p=0 "${filePath}"`;
  try {
    const { stdout } = await execAsync(cmd);
    const duration = parseFloat(stdout.trim());
    if (isNaN(duration)) throw new Error('Invalid duration');
    return duration;
  } catch (err) {
    console.error('获取视频时长失败:', err.message);
    return 0;
  }
}

/**
 * 获取音轨信息
 */
async function getAudioStreams(filePath) {
  const cmd = `${ffprobePath} -v error -select_streams a -show_entries stream=index,codec_name:stream_tags=title,language -of json "${filePath}"`;
  try {
    const { stdout } = await execAsync(cmd);
    const data = JSON.parse(stdout);
    return data.streams || [];
  } catch (err) {
    console.error('获取音轨信息失败:', err.message);
    return [];
  }
}

/**
 * 转码单个分片
 * @param {Object} opts - 转码选项
 * @returns {Promise<{success: boolean, segmentIndex: number, tsFiles: string[]}>}
 */
async function transcodeSegment(opts) {
  const { inputPath, hlsDir, segmentIndex, startTime, duration, mapArgs } = opts;

  const startTimeStr = formatTime(startTime);
  const segmentPrefix = `seg_${segmentIndex}`;
  const playlistPath = path.join(hlsDir, `stream_${segmentIndex}.m3u8`);

  const ffmpegCmd = `${ffmpegPath} -y -threads 0 ` +
    `-ss ${startTimeStr} -t ${duration} -i "${inputPath}" ${mapArgs} ` +
    `-output_ts_offset ${startTime} ` +
    `-c:v libx264 -preset veryfast -tune film -crf 23 ` +
    `-c:a aac -b:a 128k -ac 2 ` +
    `-f hls -hls_time 4 -hls_list_size 0 ` +
    `-hls_segment_type mpegts ` +
    `-hls_flags independent_segments ` +
    `-hls_segment_filename "${hlsDir}/${segmentPrefix}_%04d.ts" ` +
    `"${playlistPath}"`;

  console.log(`[分片 ${segmentIndex}] 开始转码: ${startTimeStr} 时长 ${duration}s`);

  try {
    await execAsync(ffmpegCmd, { maxBuffer: 1024 * 1024 * 50 });

    // 获取生成的 ts 文件列表
    const tsFiles = fs.readdirSync(hlsDir)
      .filter(f => f.startsWith(segmentPrefix) && f.endsWith('.ts'))
      .sort();

    console.log(`[分片 ${segmentIndex}] 转码完成, 生成 ${tsFiles.length} 个 ts 文件`);

    return { success: true, segmentIndex, tsFiles, playlistPath };
  } catch (err) {
    console.error(`[分片 ${segmentIndex}] 转码失败:`, err.message);
    return { success: false, segmentIndex, tsFiles: [], error: err.message };
  }
}

/**
 * 合并所有分片的 m3u8 播放列表
 */
function mergeHlsPlaylists(hlsDir, segmentResults, audioStreams) {
  // 读取所有分片的 m3u8 并合并
  let allSegments = [];
  let targetDuration = 4;

  for (const result of segmentResults) {
    if (!result.success) continue;

    const playlistContent = fs.readFileSync(result.playlistPath, 'utf-8');
    const lines = playlistContent.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // 提取 EXTINF 和 ts 文件
      if (line.startsWith('#EXTINF:')) {
        const duration = parseFloat(line.split(':')[1].split(',')[0]);
        targetDuration = Math.max(targetDuration, Math.ceil(duration));
        const tsFile = lines[i + 1]?.trim();
        if (tsFile && tsFile.endsWith('.ts')) {
          allSegments.push({ extinf: line, tsFile });
        }
      }
    }
  }

  // 生成合并后的主播放列表
  let masterContent = '#EXTM3U\n';
  masterContent += '#EXT-X-VERSION:3\n';
  masterContent += `#EXT-X-TARGETDURATION:${targetDuration}\n`;
  masterContent += '#EXT-X-MEDIA-SEQUENCE:0\n';
  masterContent += '#EXT-X-PLAYLIST-TYPE:VOD\n\n';

  for (const seg of allSegments) {
    masterContent += `${seg.extinf}\n${seg.tsFile}\n`;
  }

  masterContent += '#EXT-X-ENDLIST\n';

  // 写入 stream_v.m3u8 (视频+默认音轨)
  const streamPlaylist = path.join(hlsDir, 'stream_v.m3u8');
  fs.writeFileSync(streamPlaylist, masterContent);

  // 生成 master.m3u8
  let masterPlaylist = '#EXTM3U\n';
  masterPlaylist += '#EXT-X-VERSION:3\n\n';

  // 音轨信息
  if (audioStreams.length > 1) {
    audioStreams.forEach((stream, i) => {
      const name = stream.tags?.title || stream.tags?.language || `Audio${i + 1}`;
      const isDefault = i === 0 ? 'YES' : 'NO';
      masterPlaylist += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${name}",DEFAULT=${isDefault},AUTOSELECT=YES,URI="stream_v.m3u8"\n`;
    });
  }

  masterPlaylist += '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="audio"\n';
  masterPlaylist += 'stream_v.m3u8\n';

  const masterPath = path.join(hlsDir, 'master.m3u8');
  fs.writeFileSync(masterPath, masterPlaylist);

  // 清理分片播放列表
  for (const result of segmentResults) {
    if (result.playlistPath && fs.existsSync(result.playlistPath)) {
      fs.unlinkSync(result.playlistPath);
    }
  }

  return masterPath;
}

/**
 * 格式化时间为 HH:MM:SS 格式
 */
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// API 路由
app.get('/api/room/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (room) {
    res.json({
      exists: true,
      userCount: room.users.size,
      hostName: room.hostName
    });
  } else {
    res.json({ exists: false });
  }
});

// ============ B 站相关 API ============
const bilibili = require('./bilibili');

// 生成登录二维码
app.get('/api/bilibili/qrcode', async (req, res) => {
  try {
    const QRCode = require('qrcode');
    const result = await bilibili.generateQRCode();

    // 在服务端生成二维码图片的 base64
    const qrcodeDataUrl = await QRCode.toDataURL(result.url, {
      width: 200,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' }
    });

    res.json({
      success: true,
      qrcode_key: result.qrcode_key,
      qrcode_image: qrcodeDataUrl  // base64 图片
    });
  } catch (err) {
    console.error('生成二维码失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 轮询二维码状态
app.get('/api/bilibili/qrcode/poll', async (req, res) => {
  const { qrcode_key, roomId } = req.query;

  if (!qrcode_key) {
    return res.status(400).json({ success: false, error: '缺少 qrcode_key' });
  }

  try {
    const result = await bilibili.pollQRCodeStatus(qrcode_key);

    // 登录成功，保存 Cookie 到房间
    if (result.code === 0 && result.cookie && roomId) {
      bilibili.saveCookie(roomId, result.cookie);
      console.log(`房间 ${roomId} B站登录成功`);
    }

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('轮询二维码状态失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 检查登录状态
app.get('/api/bilibili/login-status', async (req, res) => {
  const { roomId } = req.query;

  if (!roomId) {
    return res.json({ success: true, isLogin: false });
  }

  const cookie = bilibili.getCookie(roomId);
  if (!cookie) {
    return res.json({ success: true, isLogin: false });
  }

  try {
    const status = await bilibili.checkLoginStatus(cookie);
    res.json({ success: true, ...status });
  } catch (err) {
    res.json({ success: true, isLogin: false });
  }
});

// 获取视频信息
app.get('/api/bilibili/video/:bvid', async (req, res) => {
  const { bvid } = req.params;
  const { roomId } = req.query;

  if (!bvid) {
    return res.status(400).json({ success: false, error: '缺少 BV 号' });
  }

  try {
    const cookie = roomId ? bilibili.getCookie(roomId) : '';
    const info = await bilibili.getVideoInfo(bvid, cookie);
    res.json({ success: true, data: info });
  } catch (err) {
    console.error('获取视频信息失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取播放地址
app.get('/api/bilibili/playurl', async (req, res) => {
  const { bvid, cid, qn = 80, roomId } = req.query;

  if (!bvid || !cid) {
    return res.status(400).json({ success: false, error: '缺少 bvid 或 cid' });
  }

  try {
    const cookie = roomId ? bilibili.getCookie(roomId) : '';
    const playurl = await bilibili.getPlayUrl(bvid, parseInt(cid), parseInt(qn), cookie);
    res.json({ success: true, data: playurl });
  } catch (err) {
    console.error('获取播放地址失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 代理视频流
app.get('/api/bilibili/proxy', (req, res) => {
  const { url, roomId } = req.query;

  if (!url) {
    return res.status(400).json({ success: false, error: '缺少视频 URL' });
  }

  try {
    const cookie = roomId ? bilibili.getCookie(roomId) : '';
    bilibili.proxyVideoStream(url, req, res, cookie);
  } catch (err) {
    console.error('代理视频流失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 退出 B 站登录
app.post('/api/bilibili/logout', (req, res) => {
  const { roomId } = req.body;

  if (roomId) {
    bilibili.deleteCookie(roomId);
  }

  res.json({ success: true });
});

// 下载 B 站视频 (分离音视频，用于 MSE 播放)
app.post('/api/bilibili/download', async (req, res) => {
  const { bvid, cid, qn, roomId } = req.body;

  if (!bvid || !cid) {
    return res.status(400).json({ success: false, error: '缺少 bvid 或 cid' });
  }

  try {
    const cookie = roomId ? bilibili.getCookie(roomId) : '';

    console.log(`[B站下载] 开始处理: ${bvid}, cid: ${cid}, qn: ${qn || 80}`);

    const result = await bilibili.downloadSeparate(
      bvid,
      parseInt(cid),
      parseInt(qn) || 80,
      cookie,
      uploadsDir,
      (progress) => {
        console.log(`[B站下载] ${progress.message} (${progress.progress}%)`);
        // 通过 Socket.IO 推送进度到房间
        if (roomId) {
          io.in(roomId).emit('bilibili-download-progress', {
            stage: progress.stage,
            progress: progress.progress,
            message: progress.message
          });
        }
      }
    );

    // 记录到房间的 B 站文件列表（用于清理）
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        room.bilibiliFiles.push(result.videoFilename, result.audioFilename);
      }
    }

    console.log(`[B站下载] 完成: video=${result.videoPath}, audio=${result.audioPath}`);

    res.json({
      success: true,
      data: {
        type: 'mse',  // 标记为 MSE 类型
        videoUrl: result.videoPath,
        audioUrl: result.audioPath,
        codecs: result.codecs
      }
    });

  } catch (err) {
    console.error('[B站下载] 失败:', err.message);
    // 通知房间下载失败
    if (roomId) {
      io.in(roomId).emit('bilibili-download-progress', {
        stage: 'error',
        progress: 0,
        message: err.message
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});


// 视频上传 API
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: '没有上传文件' });
  }

  const originalPath = req.file.path;
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();

  // 字幕文件处理
  const subtitleExts = ['.srt', '.ass', '.ssa', '.sub', '.idx'];
  if (subtitleExts.includes(ext)) {
    const filenameNoExt = path.basename(req.file.filename, path.extname(req.file.filename));
    const vttFilename = `${filenameNoExt}.vtt`;
    const vttPath = path.join(uploadsDir, vttFilename);
    const vttUrl = `/uploads/${vttFilename}`;

    console.log(`开始转换字幕: ${originalName} -> VTT...`);

    // 使用 ffmpeg 转换为 webvtt
    exec(`ffmpeg -i "${originalPath}" -f webvtt "${vttPath}"`, (error) => {
      if (error) {
        console.error(`字幕转换失败: ${error.message}`);
        // 失败尝试直接返回原文件 (可能不兼容)
        res.json({
          success: true,
          url: `/uploads/${req.file.filename}`,
          filename: originalName,
          isSubtitle: true,
          converted: false
        });
        return;
      }

      console.log(`字幕转换完成: ${vttUrl}`);

      // 删除原字幕文件
      fs.unlink(originalPath, (err) => {
        if (err) console.error('删除原字幕文件失败:', err);
      });

      res.json({
        success: true,
        url: vttUrl,
        filename: originalName,
        isSubtitle: true,
        converted: true
      });
    });
    return; // 结束字幕处理
  }

  // HLS 多音轨转换 (MP4, MOV, MKV) - 并行分片版
  if (['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv'].includes(ext)) {
    const videoId = path.basename(req.file.filename, path.extname(req.file.filename));
    const hlsDir = path.join(uploadsDir, videoId);
    const masterUrl = `/uploads/${videoId}/master.m3u8`;

    // 使用 videoId 作为进度追踪 ID
    const uploadId = videoId;

    // 创建 HLS 目录
    if (!fs.existsSync(hlsDir)) {
      fs.mkdirSync(hlsDir, { recursive: true });
    }

    console.log(`开始 HLS 并行转换: ${originalName}...`);

    // 发送初始进度
    emitProgress(uploadId, {
      filename: originalName,
      stage: 'analyzing',
      progress: 0,
      message: '正在分析视频...'
    });

    // 使用 async IIFE 处理异步逻辑
    (async () => {
      try {
        // 1. 获取视频时长和音轨信息
        const [duration, audioStreams] = await Promise.all([
          getVideoDuration(originalPath),
          getAudioStreams(originalPath)
        ]);

        console.log(`视频时长: ${duration}s, 音轨数: ${audioStreams.length}`);

        emitProgress(uploadId, {
          filename: originalName,
          stage: 'analyzing',
          progress: 10,
          message: `视频时长: ${Math.floor(duration / 60)}分${Math.floor(duration % 60)}秒, ${audioStreams.length} 个音轨`
        });

        if (duration <= 0) {
          throw new Error('无法获取视频时长');
        }

        // 2. 计算分片
        const numSegments = Math.ceil(duration / SEGMENT_DURATION);
        const segments = [];

        for (let i = 0; i < numSegments; i++) {
          const startTime = i * SEGMENT_DURATION;
          const segDuration = Math.min(SEGMENT_DURATION, duration - startTime);
          segments.push({ index: i, startTime, duration: segDuration });
        }

        console.log(`分片计划: ${numSegments} 个分片, 并行度: ${Math.min(numSegments, MAX_PARALLEL_WORKERS)}`);

        emitProgress(uploadId, {
          filename: originalName,
          stage: 'transcoding',
          progress: 15,
          message: `分片计划: ${numSegments} 个分片`,
          segmentInfo: { current: 0, total: numSegments, completed: 0 }
        });

        // 3. 构建 map 参数
        let mapArgs = '-map 0:v:0';
        for (let i = 0; i < audioStreams.length; i++) {
          mapArgs += ` -map 0:a:${i}?`;
        }

        // 4. 并行转码 (限制并发数) - 带进度追踪
        const results = [];
        let completedSegments = 0;

        for (let i = 0; i < segments.length; i += MAX_PARALLEL_WORKERS) {
          const batch = segments.slice(i, i + MAX_PARALLEL_WORKERS);
          const batchPromises = batch.map(seg =>
            transcodeSegment({
              inputPath: originalPath,
              hlsDir,
              segmentIndex: seg.index,
              startTime: seg.startTime,
              duration: seg.duration,
              mapArgs
            }).then(result => {
              // 每个分片完成后更新进度
              completedSegments++;
              const progress = 15 + Math.floor((completedSegments / numSegments) * 75); // 15-90%
              emitProgress(uploadId, {
                filename: originalName,
                stage: 'transcoding',
                progress,
                message: `转码分片 ${completedSegments}/${numSegments}`,
                segmentInfo: { current: seg.index + 1, total: numSegments, completed: completedSegments }
              });
              return result;
            })
          );
          const batchResults = await Promise.all(batchPromises);
          results.push(...batchResults);
        }

        // 5. 检查是否有失败的分片
        const failedSegments = results.filter(r => !r.success);
        if (failedSegments.length > 0) {
          console.error(`${failedSegments.length} 个分片转码失败`);
          throw new Error(`分片转码失败: ${failedSegments.map(s => s.segmentIndex).join(', ')}`);
        }

        // 6. 合并播放列表
        console.log('合并 HLS 播放列表...');
        emitProgress(uploadId, {
          filename: originalName,
          stage: 'merging',
          progress: 92,
          message: '正在合并播放列表...'
        });

        mergeHlsPlaylists(hlsDir, results, audioStreams);

        console.log(`HLS 并行转换完成: ${masterUrl}`);

        // 发送完成进度
        emitProgress(uploadId, {
          filename: originalName,
          stage: 'complete',
          progress: 100,
          message: '转码完成！'
        });

        // 清理进度记录
        setTimeout(() => transcodeProgress.delete(uploadId), 60000);

        // 删除原文件
        fs.unlink(originalPath, (err) => {
          if (err) console.error('删除原文件失败:', err);
        });

        res.json({
          success: true,
          url: masterUrl,
          filename: originalName,
          size: req.file.size,
          hls: true,
          audioTracks: audioStreams.length,
          parallelSegments: numSegments,
          uploadId
        });

      } catch (error) {
        console.error(`HLS 并行转换失败: ${error.message}`);

        // 发送错误进度
        emitProgress(uploadId, {
          filename: originalName,
          stage: 'error',
          progress: 0,
          message: `并行转码失败，尝试降级转码...`
        });

        // 降级：尝试单进程转码
        console.log('尝试降级为单进程转码...');

        emitProgress(uploadId, {
          filename: originalName,
          stage: 'transcoding',
          progress: 10,
          message: '降级为单进程转码...'
        });

        const audioStreams = await getAudioStreams(originalPath);
        let mapArgs = '-map 0:v:0';
        for (let i = 0; i < audioStreams.length; i++) {
          mapArgs += ` -map 0:a:${i}?`;
        }

        const fallbackCmd = `${ffmpegPath} -y -threads 0 -i "${originalPath}" ${mapArgs} ` +
          `-c:v libx264 -preset veryfast -tune film -crf 23 ` +
          `-c:a aac -b:a 128k -ac 2 ` +
          `-f hls -hls_time 4 -hls_list_size 0 ` +
          `-hls_segment_type mpegts ` +
          `-hls_flags independent_segments ` +
          `-hls_segment_filename "${hlsDir}/seg_%04d.ts" ` +
          `"${hlsDir}/stream_v.m3u8"`;

        try {
          await execAsync(fallbackCmd, { maxBuffer: 1024 * 1024 * 50 });

          emitProgress(uploadId, {
            filename: originalName,
            stage: 'complete',
            progress: 100,
            message: '转码完成！(降级模式)'
          });

          // 生成简单的 master.m3u8
          const masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n\n' +
            '#EXT-X-STREAM-INF:BANDWIDTH=2000000\nstream_v.m3u8\n';
          fs.writeFileSync(path.join(hlsDir, 'master.m3u8'), masterContent);

          fs.unlink(originalPath, () => { });

          res.json({
            success: true,
            url: masterUrl,
            filename: originalName,
            size: req.file.size,
            hls: true,
            audioTracks: audioStreams.length,
            fallback: true
          });
        } catch (fallbackErr) {
          console.error('降级转码也失败:', fallbackErr.message);

          // 最终降级：直接返回原文件
          const fileUrl = `/uploads/${req.file.filename}`;
          res.json({
            success: true,
            url: fileUrl,
            filename: originalName,
            size: req.file.size,
            hls: false
          });

          fs.rm(hlsDir, { recursive: true, force: true }, () => { });
        }
      }
    })();
  } else {
    // 其他格式直接返回
    const fileUrl = `/uploads/${req.file.filename}`;
    console.log(`视频上传成功 (未处理): ${originalName} -> ${fileUrl}`);
    res.json({
      success: true,
      url: fileUrl,
      filename: originalName,
      size: req.file.size
    });
  }
});

// 上传错误处理
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: '文件大小不能超过 500MB' });
    }
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  next();
});

// 权限检查辅助函数
function checkPermission(room, socketId, action) {
  if (!room) return false;

  // 房主始终有权限
  if (room.isHost(socketId)) return true;

  // 根据不同操作检查权限
  switch (action) {
    case 'change-video':
      return room.settings.allowAllChangeVideo;
    case 'change-subtitle':
      return room.settings.allowAllChangeSubtitle;
    case 'control':
      return room.settings.allowAllControl;
    default:
      return false;
  }
}

// Socket.io 事件处理
io.on('connection', (socket) => {
  console.log(`用户连接: ${socket.id}`);

  let currentRoom = null;
  let currentUserName = null;

  // 创建房间
  socket.on('create-room', ({ userName }, callback) => {
    const roomId = uuidv4().substring(0, 8).toUpperCase();
    const room = new Room(roomId, userName);
    // 不要在这里添加用户和设置 hostId
    // 让用户跳转到 room.html 后通过 join-room 加入
    // addUser 会自动将第一个用户设为房主
    rooms.set(roomId, room);

    console.log(`房间创建: ${roomId} by ${userName}`);

    callback({
      success: true,
      roomId,
      isHost: true
    });
  });

  // 加入房间
  socket.on('join-room', ({ roomId, userName, userId }, callback) => {
    const room = rooms.get(roomId);

    if (!room) {
      callback({ success: false, error: '房间不存在' });
      return;
    }

    // 如果没有 userId，使用 socket.id 作为临时 ID (降级兼容)
    const effectiveUserId = userId || socket.id;

    room.addUser(socket.id, userName, effectiveUserId);
    socket.join(roomId);
    currentRoom = roomId;
    currentUserName = userName;

    // 通知房间内其他用户
    socket.to(roomId).emit('user-joined', {
      userId: socket.id,
      userName,
      userList: room.getUserList()
    });

    console.log(`${userName} 加入房间 ${roomId}`);

    callback({
      success: true,
      roomId,
      isHost: room.isHost(socket.id),
      videoUrl: room.videoUrl,
      subtitleUrl: room.subtitleUrl,
      mseData: room.mseData || null, // B站视频的分离音视频数据
      videoState: room.videoState,
      userList: room.getUserList(),
      messages: room.messages.slice(-50), // 发送最近50条消息
      settings: room.settings // 添加房间设置
    });
  });

  // 更换视频源
  socket.on('change-video', ({ url, mseData }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    // 权限检查
    if (!checkPermission(room, socket.id, 'change-video')) {
      socket.emit('permission-denied', { action: 'change-video', message: '只有房主可以更换视频' });
      return;
    }

    room.videoUrl = url;
    room.mseData = mseData || null;  // 保存 MSE 数据
    room.videoState = {
      isPlaying: false,
      currentTime: 0,
      lastUpdated: Date.now()
    };

    // 广播给房间内所有人（包括自己）
    io.to(currentRoom).emit('video-changed', {
      url,
      mseData,
      changedBy: currentUserName
    });

    console.log(`房间 ${currentRoom} 视频更换为: ${url}${mseData ? ' (MSE)' : ''}`);
  });

  // 更换字幕
  socket.on('change-subtitle', ({ url, filename }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    // 权限检查
    if (!checkPermission(room, socket.id, 'change-subtitle')) {
      socket.emit('permission-denied', { action: 'change-subtitle', message: '只有房主可以更换字幕' });
      return;
    }

    room.subtitleUrl = url;

    // 广播给房间内所有人
    io.to(currentRoom).emit('subtitle-changed', {
      url,
      filename,
      changedBy: currentUserName
    });

    console.log(`房间 ${currentRoom} 字幕更换为: ${filename}`);
  });

  // 视频播放控制同步
  socket.on('video-play', ({ currentTime }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.videoState = {
      isPlaying: true,
      currentTime,
      lastUpdated: Date.now()
    };

    socket.to(currentRoom).emit('sync-play', {
      currentTime,
      triggeredBy: currentUserName
    });
  });

  socket.on('video-pause', ({ currentTime }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.videoState = {
      isPlaying: false,
      currentTime,
      lastUpdated: Date.now()
    };

    socket.to(currentRoom).emit('sync-pause', {
      currentTime,
      triggeredBy: currentUserName
    });
  });

  socket.on('video-seek', ({ currentTime }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.videoState.currentTime = currentTime;
    room.videoState.lastUpdated = Date.now();

    socket.to(currentRoom).emit('sync-seek', {
      currentTime,
      triggeredBy: currentUserName
    });
  });

  // 播放速度同步
  socket.on('video-speed', ({ playbackRate }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.videoState.playbackRate = playbackRate;
    room.videoState.lastUpdated = Date.now();

    socket.to(currentRoom).emit('sync-speed', {
      playbackRate,
      triggeredBy: currentUserName
    });
  });

  // 字幕轨道同步
  socket.on('sync-subtitle-track', ({ trackIndex }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('sync-subtitle-track', { trackIndex });
  });

  // 请求同步（新加入用户）
  socket.on('request-sync', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    socket.emit('force-sync', {
      videoUrl: room.videoUrl,
      videoState: room.videoState
    });
  });

  // 聊天消息
  socket.on('chat-message', ({ text }) => {
    if (!currentRoom || !currentUserName) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const message = room.addMessage(socket.id, currentUserName, text);

    // 广播给房间内所有人
    io.to(currentRoom).emit('new-message', message);
  });

  // 弹幕消息
  socket.on('send-danmaku', (data) => {
    if (!currentRoom || !currentUserName) return;

    // 广播给房间内其他人 (发送者自己已经在本地显示了)
    // 但为了确保多端同步，广播给所有人也没问题，前端做了过滤
    io.to(currentRoom).emit('broadcast-danmaku', {
      ...data,
      userId: socket.id,
      userName: currentUserName
    });
  });

  // 更新房间设置
  socket.on('update-settings', ({ settings }, callback) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    // 只有房主可以修改设置
    if (!room.isHost(socket.id)) {
      if (callback) callback({ success: false, error: '只有房主可以修改房间设置' });
      return;
    }

    room.updateSettings(settings);

    // 广播给房间内所有人
    io.to(currentRoom).emit('settings-updated', {
      settings: room.settings,
      updatedBy: currentUserName
    });

    console.log(`房间 ${currentRoom} 设置已更新:`, settings);

    if (callback) callback({ success: true, settings: room.settings });
  });

  // 修改昵称
  socket.on('change-nickname', ({ newName }, callback) => {
    if (!currentRoom || !newName) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const trimmedName = newName.trim();
    if (!trimmedName || trimmedName.length > 10) {
      if (callback) callback({ success: false, error: '昵称长度必须在 1-10 个字符之间' });
      return;
    }

    const oldName = currentUserName;
    if (room.updateUserName(socket.id, trimmedName)) {
      currentUserName = trimmedName;

      // 广播给房间内所有人
      io.to(currentRoom).emit('nickname-changed', {
        userId: socket.id,
        oldName,
        newName: trimmedName,
        userList: room.getUserList()
      });

      console.log(`用户 ${oldName} 改名为 ${trimmedName}`);

      if (callback) callback({ success: true, newName: trimmedName });
    } else {
      if (callback) callback({ success: false, error: '修改昵称失败' });
    }
  });

  // 转让房主
  socket.on('transfer-host', ({ targetUserId }, callback) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    // 只有当前房主可以转让
    if (!room.isHost(socket.id)) {
      if (callback) callback({ success: false, error: '只有房主可以转让权限' });
      return;
    }

    if (room.transferHost(targetUserId)) {
      // 广播给房间内所有人
      io.to(currentRoom).emit('host-transferred', {
        oldHostId: socket.id,
        newHostId: targetUserId,
        userList: room.getUserList()
      });

      console.log(`房间 ${currentRoom} 房主转让: ${socket.id} -> ${targetUserId}`);

      if (callback) callback({ success: true });
    } else {
      if (callback) callback({ success: false, error: '目标用户不存在' });
    }
  });

  // 用户断开连接
  socket.on('disconnect', () => {
    console.log(`用户断开: ${socket.id}`);

    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.removeUser(socket.id);

        // 通知其他用户
        socket.to(currentRoom).emit('user-left', {
          userId: socket.id,
          userName: currentUserName,
          userList: room.getUserList()
        });

        // 如果房间空了，延迟删除房间
        if (room.users.size === 0) {
          setTimeout(() => {
            const r = rooms.get(currentRoom);
            if (r && r.users.size === 0) {
              // 清理上传的文件
              try {
                if (r.videoUrl && r.videoUrl.startsWith('/uploads/')) {
                  // HLS 目录或单个文件
                  const urlPath = r.videoUrl.replace('/uploads/', '');
                  if (urlPath.includes('/')) {
                    // HLS: 删除整个目录
                    const dirName = urlPath.split('/')[0];
                    const dirPath = path.join(uploadsDir, dirName);
                    if (fs.existsSync(dirPath)) {
                      fs.rmSync(dirPath, { recursive: true, force: true });
                      console.log(`清理 HLS 目录: ${dirName}`);
                    }
                  } else {
                    // 单个文件
                    const filePath = path.join(uploadsDir, urlPath);
                    if (fs.existsSync(filePath)) {
                      fs.unlinkSync(filePath);
                      console.log(`清理文件: ${urlPath}`);
                    }
                  }
                }
                if (r.subtitleUrl && r.subtitleUrl.startsWith('/uploads/')) {
                  const filename = path.basename(r.subtitleUrl);
                  const filePath = path.join(uploadsDir, filename);
                  if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`清理字幕: ${filename}`);
                  }
                }
              } catch (e) {
                console.error('清理文件失败:', e);
              }

              // 清理 B 站下载的文件
              if (r.bilibiliFiles && r.bilibiliFiles.length > 0) {
                for (const filename of r.bilibiliFiles) {
                  try {
                    const filePath = path.join(uploadsDir, filename);
                    if (fs.existsSync(filePath)) {
                      fs.unlinkSync(filePath);
                      console.log(`清理B站视频: ${filename}`);
                    }
                  } catch (e) {
                    console.error('清理B站文件失败:', e);
                  }
                }
              }

              // 清理 B 站 Cookie
              bilibili.deleteCookie(currentRoom);

              rooms.delete(currentRoom);
              console.log(`房间 ${currentRoom} 已删除（无人）`);
            }
          }, 600000); // 10分钟后删除空房间，防止网络波动导致房间消失
        }
      }
    }
  });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║                                                  ║
║   🎬 在线电影放映室服务器已启动                    ║
║                                                  ║
║   本地访问: http://localhost:${PORT}               ║
║                                                  ║
╚══════════════════════════════════════════════════╝
  `);
});
