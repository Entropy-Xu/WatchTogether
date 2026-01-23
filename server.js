const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { exec } = require('child_process');

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

  // HLS 多音轨转换 (MP4, MOV, MKV)
  if (['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv'].includes(ext)) {
    const videoId = path.basename(req.file.filename, path.extname(req.file.filename));
    const hlsDir = path.join(uploadsDir, videoId);
    const masterPlaylist = path.join(hlsDir, 'master.m3u8');
    const masterUrl = `/uploads/${videoId}/master.m3u8`;

    // 创建 HLS 目录
    if (!fs.existsSync(hlsDir)) {
      fs.mkdirSync(hlsDir, { recursive: true });
    }

    console.log(`开始 HLS 转换: ${originalName}...`);

    // 使用 ffprobe 检测音轨数量和元数据 (JSON 输出)
    // 使用宝塔面板安装的 ffmpeg 路径
    const ffmpegDir = '/www/server/ffmpeg/ffmpeg-6.1';
    const ffprobePath = `${ffmpegDir}/ffprobe`;
    const ffmpegPath = `${ffmpegDir}/ffmpeg`;
    // 获取音轨的 index, codec, title, language
    const probeCmd = `${ffprobePath} -v error -select_streams a -show_entries stream=index,codec_name:stream_tags=title,language -of json "${originalPath}"`;
    console.log('ffprobe 命令:', probeCmd);

    exec(probeCmd, (probeErr, probeOut, probeStderr) => {
      let numAudio = 1;
      let audioStreams = [];

      // 调试输出
      if (probeErr) {
        console.error('ffprobe 错误:', probeErr.message);
      }
      if (probeStderr) {
        console.error('ffprobe stderr:', probeStderr);
      }
      console.log('ffprobe 原始输出:', probeOut);

      try {
        if (!probeErr && probeOut && probeOut.trim()) {
          const probeData = JSON.parse(probeOut);
          if (probeData.streams && probeData.streams.length > 0) {
            audioStreams = probeData.streams;
            numAudio = audioStreams.length;
            console.log('检测到的音轨:', audioStreams.map((s, i) => {
              const title = s.tags?.title || s.tags?.language || `Audio${i + 1}`;
              return `音轨${i + 1}: ${s.codec_name} (${title})`;
            }).join(', '));
          }
        }
      } catch (parseErr) {
        console.error('ffprobe JSON 解析失败:', parseErr.message);
        console.error('原始输出:', probeOut);
      }

      console.log(`检测到 ${numAudio} 个音轨`);

      // 构建 FFmpeg 命令 (多核优化版 - 32核服务器)
      // -threads 0: 全局线程数自动最大化
      // -c:v libx264: 使用 x264 编码器 (支持多线程)
      // -preset fast: 快速预设 (平衡速度与质量)
      // -crf 23: 质量控制 (18-28, 越小质量越好)
      // -x264-params: x264 多线程参数
      //   threads=28: 编码线程数
      //   sliced-threads=1: 启用切片线程
      //   lookahead_threads=8: 预读线程
      // -c:a aac -b:a 192k: 音频转 AAC
      // -hls_time 4: 每个片段 4 秒
      // -hls_list_size 0: 完整播放列表

      let mapArgs = '-map 0:v:0';
      let varStreamMap = 'v:0,agroup:audio';

      for (let i = 0; i < numAudio; i++) {
        mapArgs += ` -map 0:a:${i}?`;
        // 使用原始音轨名称，如果没有则使用语言或默认名称
        let trackName = `Audio${i + 1}`;
        if (audioStreams[i]?.tags) {
          const tags = audioStreams[i].tags;
          if (tags.title) {
            trackName = tags.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff\-_]/g, '_');
          } else if (tags.language) {
            trackName = tags.language;
          }
        }
        varStreamMap += ` a:${i},agroup:audio,name:${trackName}`;
      }

      // 多核优化参数 (32核 - 全力压榨)
      // threads=32: 使用全部核心
      // sliced-threads=1: 启用切片级多线程
      // lookahead_threads=8: 预读线程
      // b-adapt=2: 自适应 B 帧 (更高计算量)
      // rc-lookahead=60: 更长的预读帧数 (更高质量)
      const x264Params = 'threads=32:sliced-threads=1:lookahead_threads=8:b-adapt=2:rc-lookahead=60';

      const ffmpegCmd = `${ffmpegPath} -y -threads 0 -i "${originalPath}" ${mapArgs} ` +
        `-c:v libx264 -preset slow -crf 22 -x264opts ${x264Params} ` +
        `-c:a aac -b:a 192k -ac 2 ` +
        `-f hls ` +
        `-hls_time 4 ` +
        `-hls_list_size 0 ` +
        `-hls_segment_type mpegts ` +
        `-hls_flags independent_segments ` +
        `-hls_segment_filename "${hlsDir}/seg_%v_%04d.ts" ` +
        `-master_pl_name master.m3u8 ` +
        `-var_stream_map "${varStreamMap}" ` +
        `"${hlsDir}/stream_%v.m3u8"`;

      console.log('FFmpeg 命令:', ffmpegCmd);

      exec(ffmpegCmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
        if (error) {
          console.error(`HLS 转换失败: ${error.message}`);
          console.error('FFmpeg stderr:', stderr);

          // 降级：直接返回原文件
          const fileUrl = `/uploads/${req.file.filename}`;
          res.json({
            success: true,
            url: fileUrl,
            filename: originalName,
            size: req.file.size,
            hls: false
          });

          // 清理空目录
          fs.rmdir(hlsDir, { recursive: true }, () => { });
          return;
        }

        console.log(`HLS 转换完成: ${masterUrl}`);

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
          audioTracks: numAudio
        });
      });
    });
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
