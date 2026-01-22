const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

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
    // 允许的视频格式
    const allowedTypes = /mp4|webm|mkv|avi|mov|m4v|ogg|ogv|flv|wmv|ts/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = file.mimetype.startsWith('video/');

    if (extname || mimetype) {
      cb(null, true);
    } else {
      cb(new Error('只支持视频文件格式'));
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

  const fileUrl = `/uploads/${req.file.filename}`;

  console.log(`视频上传成功: ${req.file.originalname} -> ${fileUrl}`);

  res.json({
    success: true,
    url: fileUrl,
    filename: req.file.originalname,
    size: req.file.size
  });
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
