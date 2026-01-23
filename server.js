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
    this.hostId = null;
    this.hostName = hostName;
    this.videoUrl = '';
    this.subtitleUrl = null; // 字幕 URL
    this.videoState = {
      isPlaying: false,
      currentTime: 0,
      lastUpdated: Date.now()
    };
    this.users = new Map(); // socketId -> { name, joinedAt }
    this.messages = [];
    this.createdAt = Date.now();
  }

  addUser(socketId, name) {
    this.users.set(socketId, {
      name,
      joinedAt: Date.now()
    });
    if (!this.hostId) {
      this.hostId = socketId;
    }
  }

  removeUser(socketId) {
    this.users.delete(socketId);
    // 如果房主离开，转移房主权限
    if (this.hostId === socketId && this.users.size > 0) {
      this.hostId = this.users.keys().next().value;
    }
  }

  getUserList() {
    const list = [];
    this.users.forEach((user, socketId) => {
      list.push({
        id: socketId,
        name: user.name,
        isHost: socketId === this.hostId
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
}

// ============ 并行分片转码配置 ============
const ffmpegDir = '/usr/local/bin';
const ffprobePath = `${ffmpegDir}/ffprobe`;
const ffmpegPath = `${ffmpegDir}/ffmpeg`;

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

// Socket.io 事件处理
io.on('connection', (socket) => {
  console.log(`用户连接: ${socket.id}`);

  let currentRoom = null;
  let currentUserName = null;

  // 创建房间
  socket.on('create-room', ({ userName }, callback) => {
    const roomId = uuidv4().substring(0, 8).toUpperCase();
    const room = new Room(roomId, userName);
    room.addUser(socket.id, userName);
    room.hostId = socket.id;
    rooms.set(roomId, room);

    socket.join(roomId);
    currentRoom = roomId;
    currentUserName = userName;

    console.log(`房间创建: ${roomId} by ${userName}`);

    callback({
      success: true,
      roomId,
      isHost: true
    });
  });

  // 加入房间
  socket.on('join-room', ({ roomId, userName }, callback) => {
    const room = rooms.get(roomId);

    if (!room) {
      callback({ success: false, error: '房间不存在' });
      return;
    }

    room.addUser(socket.id, userName);
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
      isHost: room.hostId === socket.id,
      videoUrl: room.videoUrl,
      subtitleUrl: room.subtitleUrl,
      videoState: room.videoState,
      userList: room.getUserList(),
      messages: room.messages.slice(-50) // 发送最近50条消息
    });
  });

  // 更换视频源
  socket.on('change-video', ({ url }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.videoUrl = url;
    room.videoState = {
      isPlaying: false,
      currentTime: 0,
      lastUpdated: Date.now()
    };

    // 广播给房间内所有人（包括自己）
    io.to(currentRoom).emit('video-changed', {
      url,
      changedBy: currentUserName
    });

    console.log(`房间 ${currentRoom} 视频更换为: ${url}`);
  });

  // 更换字幕
  socket.on('change-subtitle', ({ url, filename }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

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
