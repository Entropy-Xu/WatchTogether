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

  // 仅对 MP4, MOV, MKV 进行 faststart 优化
  // 注意：这里我们统一转为 mp4 容器以确保最佳兼容性
  if (['.mp4', '.mov', '.mkv'].includes(ext)) {
    const filenameNoExt = path.basename(req.file.filename, path.extname(req.file.filename));
    const optimizedFilename = `${filenameNoExt}_optimized.mp4`;
    const optimizedPath = path.join(uploadsDir, optimizedFilename);
    const optimizedUrl = `/uploads/${optimizedFilename}`;

    console.log(`开始优化视频: ${originalName}...`);

    // 使用 ffmpeg 进行 faststart 优化
    // -c copy: 不重新编码，只复制流（速度快）
    // -movflags +faststart: 移动 moov atom 到文件头
    exec(`ffmpeg -i "${originalPath}" -c copy -movflags +faststart "${optimizedPath}"`, (error, stdout, stderr) => {
      if (error) {
        console.error(`优化失败: ${error.message}`);
        // 优化失败则降级使用原文件
        const fileUrl = `/uploads/${req.file.filename}`;
        res.json({
          success: true,
          url: fileUrl,
          filename: originalName,
          size: req.file.size,
          optimized: false
        });
        return;
      }

      console.log(`视频优化完成: ${optimizedUrl}`);

      // 删除原文件（可选，为了节省空间）
      fs.unlink(originalPath, (err) => {
        if (err) console.error('删除原文件失败:', err);
      });

      res.json({
        success: true,
        url: optimizedUrl,
        filename: originalName,
        size: req.file.size, // 注意：这是原大小，优化后可能略有不同
        optimized: true
      });
    });
  } else {
    // 其他格式直接返回
    const fileUrl = `/uploads/${req.file.filename}`;
    console.log(`视频上传成功 (未优化): ${originalName} -> ${fileUrl}`);
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
              rooms.delete(currentRoom);
              console.log(`房间 ${currentRoom} 已删除（无人）`);
            }
          }, 60000); // 1分钟后删除空房间
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
