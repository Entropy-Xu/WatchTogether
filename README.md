# 🎬 Online Media Player (在线电影放映室)

<div align="center">

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org/)
[![Socket.io](https://img.shields.io/badge/Socket.io-v4-orange)](https://socket.io/)

[English](./README_EN.md) | 简体中文

一个极简、现代化的在线电影同步放映室。邀请朋友，共享观影时光。

![preview](https://github.com/user-attachments/assets/46691c24-d448-48ab-ba28-b914c46bd08e)

[功能特性](#-核心特性) •
[快速开始](#-快速开始) •
[部署指南](#-部署) •
[常见问题](#-常见问题) •
[贡献指南](#-贡献)

</div>

---

## 📖 目录

- [核心特性](#-核心特性)
- [技术栈](#️-技术栈)
- [环境要求](#-环境要求)
- [快速开始](#-快速开始)
- [使用指南](#-使用指南)
- [配置选项](#️-配置选项)
- [部署](#-部署)
- [项目结构](#-项目结构)
- [常见问题](#-常见问题)
- [贡献](#-贡献)
- [许可证](#-许可证)

---

## ✨ 核心特性

### 💎 极致体验
- **沉浸式 UI**: 采用 Glassmorphism（玻璃拟态）设计风格，深色影院模式
- **全平台适配**: 支持桌面端、平板（iPad）及移动端设备
- **实时弹幕**: Bilibili 风格的弹幕互动，与聊天消息双向联动
- **自定义播放器**: 全自定义控制栏，支持倍速、音量、全屏等

### 🚀 高性能播放
- **多格式支持**: MP4, MKV, MOV, AVI, FLV, HLS (m3u8), DASH 等
- **HLS 多音轨**: 自动转码为 HLS 格式，支持多音轨选择
- **字幕支持**: 支持 SRT, ASS, SSA 字幕上传和切换
- **并行转码**: 大文件自动分片并行转码，大幅加速处理
- **毫秒级同步**: 基于 Socket.io 的精准同步算法

### 🎛️ 播放控制
- **倍速选择**: 0.5x ~ 2.0x 倍速播放
- **音轨切换**: HLS 多音轨视频支持音轨选择
- **字幕选择**: 上传字幕后可开关和切换
- **全屏模式**: 自动隐藏 UI，鼠标移动时显示

### 💬 互动功能
- **实时聊天**: 内置聊天室，无需切换软件
- **弹幕系统**: 视频上方滚动弹幕，与聊天消息联动
- **房间管理**: 房主可控制权限（视频切换、字幕切换、播放控制）

## 🛠️ 技术栈

| 类别 | 技术 |
|------|------|
| Frontend | HTML5, CSS3, JavaScript ES6+, FontAwesome v6 |
| Backend | Node.js, Express |
| Real-time | Socket.io v4 |
| Media | FFmpeg (并行分片转码), HLS.js, Video.js |
| Storage | 纯内存存储（重启即销毁） |

## 📦 环境要求

- **Node.js**: v16.0.0+
- **FFmpeg**: 必须安装（用于视频转码）

### 安装 FFmpeg
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# CentOS
yum install ffmpeg
```

## 🚀 快速开始

### 前置要求
确保你的系统已安装：
- **Node.js** v16.0.0 或更高版本
- **FFmpeg**（用于视频转码）

### 安装步骤

```bash
# 1. 克隆项目
git clone https://github.com/Entropy-Xu/OnlineMediaPlayer.git
cd OnlineMediaPlayer

# 2. 安装依赖
npm install

# 3. 启动服务器
npm start
# 或开发模式（自动重启）
npm run dev

# 4. 访问应用
# 打开浏览器访问: http://localhost:3000
```

服务器默认运行在 `http://localhost:3000`。你可以通过环境变量 `PORT` 自定义端口。

---

## 📚 使用指南

### 创建放映室
1. 打开首页 `http://localhost:3000`
2. 在「创建放映室」卡片中输入你的昵称
3. 点击「创建放映室」按钮
4. 系统会生成一个 8 位房间号，分享给你的朋友

### 加入放映室
1. 打开首页
2. 在「加入放映室」卡片中输入昵称和房间号
3. 点击「加入放映室」按钮

### 上传视频
1. 进入放映室后，点击「选择视频」按钮
2. 选择本地视频文件（支持 MP4, MKV, MOV, AVI, FLV 等格式）
3. 等待上传和转码完成（大文件会自动进行 HLS 转码）
4. 视频会自动同步到所有观众

### 上传字幕
1. 点击「上传字幕」按钮
2. 选择字幕文件（支持 SRT, ASS, SSA 格式）
3. 上传后可以在播放器中切换字幕

### 权限控制
- **房主权限**：默认拥有所有控制权（视频切换、字幕、播放控制）
- **权限设置**：房主可以通过设置按钮调整权限
  - 允许/禁止其他人切换视频
  - 允许/禁止其他人切换字幕
  - 允许/禁止其他人控制播放

### 实时互动
- **聊天**：在右侧聊天框输入消息并发送
- **弹幕**：聊天消息会以金色弹幕形式显示在视频上方
- **同步播放**：任何人的播放/暂停/跳转操作都会同步到所有观众

---

## ⚙️ 配置选项

### 环境变量

你可以通过环境变量自定义服务器配置：

```bash
# 自定义端口（默认: 3000）
PORT=8080 npm start

# 或创建 .env 文件
echo "PORT=8080" > .env
npm start
```

### 文件上传限制

默认情况下，文件上传大小无限制。如果使用 Nginx 反向代理，需要设置：

```nginx
client_max_body_size 1024M;  # 或更大
```

---

## 🐳 部署

### 方式一：宝塔面板
详细部署指南请查看 👉 **[DEPLOY_BAOTA.md](DEPLOY_BAOTA.md)**

### 方式二：Docker

#### 使用 Docker Compose（推荐）

1. 创建 `docker-compose.yml` 文件：

```yaml
version: '3.8'

services:
  online-media-player:
    image: node:18-alpine
    container_name: online-media-player
    working_dir: /app
    volumes:
      - .:/app
      - /app/node_modules
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - NODE_ENV=production
    command: sh -c "apk add --no-cache ffmpeg && npm install && npm start"
    restart: unless-stopped
```

2. 启动服务：

```bash
docker-compose up -d
```

#### 使用 Dockerfile

1. 创建 `Dockerfile`：

```dockerfile
FROM node:18-alpine

# 安装 FFmpeg
RUN apk add --no-cache ffmpeg

# 设置工作目录
WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm install --production

# 复制项目文件
COPY . .

# 创建上传目录
RUN mkdir -p uploads

# 暴露端口
EXPOSE 3000

# 启动应用
CMD ["npm", "start"]
```

2. 构建并运行：

```bash
# 构建镜像
docker build -t online-media-player .

# 运行容器
docker run -d -p 3000:3000 --name media-player online-media-player
```

### 方式三：传统部署

1. 确保服务器已安装 Node.js 和 FFmpeg
2. 克隆项目到服务器
3. 安装依赖：`npm install`
4. 使用 PM2 管理进程：

```bash
# 安装 PM2
npm install -g pm2

# 启动应用
pm2 start server.js --name online-media-player

# 设置开机自启
pm2 startup
pm2 save
```

### 反向代理配置（Nginx）

如果使用 Nginx 作为反向代理，需要配置 WebSocket 支持：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        
        # 文件上传大小限制
        client_max_body_size 1024M;
    }
}
```

---

## 📁 项目结构

```
OnlineMediaPlayer/
├── public/                 # 前端静态文件
│   ├── index.html         # 首页（创建/加入房间）
│   ├── room.html          # 放映室页面
│   ├── css/
│   │   └── style.css      # 样式文件
│   └── js/
│       ├── app.js         # 首页逻辑
│       └── room.js        # 放映室逻辑
├── uploads/               # 上传文件存储目录（运行时创建）
├── server.js              # Node.js 服务器主文件
├── package.json           # 项目依赖配置
├── README.md              # 项目说明文档
└── DEPLOY_BAOTA.md        # 宝塔面板部署指南
```

### 核心模块说明

- **server.js**：Express 服务器 + Socket.io 实时通信 + 文件上传处理 + FFmpeg 视频转码
- **room.js**：房间管理、视频同步、聊天和弹幕功能
- **app.js**：房间创建和加入逻辑

---

## ❓ 常见问题

### 安装和配置

**Q: 如何安装 FFmpeg？**  
A: 
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt update && sudo apt install ffmpeg -y

# CentOS/RHEL
sudo yum install epel-release -y
sudo yum install ffmpeg -y

# Windows (使用 Chocolatey)
choco install ffmpeg
```

验证安装：`ffmpeg -version`

**Q: 如何更改默认端口？**  
A: 使用环境变量：`PORT=8080 npm start` 或在代码中修改 `server.js` 中的 `PORT` 常量。

### 上传和播放

**Q: 上传大文件加载很慢？**  
A: 确保已安装 FFmpeg。项目会自动进行 HLS 转码和并行分片处理。大文件（>100MB）会自动分片转码以加速处理。

**Q: 支持哪些视频格式？**  
A: 支持几乎所有常见格式：MP4, MKV, MOV, AVI, FLV, WMV, WebM, OGV 等。非标准格式会自动转码为 HLS。

**Q: 视频上传有大小限制吗？**  
A: 应用本身无限制，但需注意：
- Nginx 反向代理需要配置 `client_max_body_size`
- 服务器磁盘空间
- 网络带宽和上传时间

**Q: 字幕不显示？**  
A: 
1. 确保字幕文件编码为 UTF-8
2. 检查字幕格式是否支持（SRT, ASS, SSA）
3. 尝试重新上传字幕文件

### 同步和连接

**Q: 支持多人同时观看吗？**  
A: 是的！任何人的播放/暂停/跳转操作都会同步到所有观众。同步延迟通常在毫秒级别。

**Q: WebSocket 连接失败？**  
A: 
1. 检查防火墙是否允许端口访问
2. 如果使用反向代理，确保正确配置了 WebSocket 升级头
3. 查看浏览器控制台的错误信息

**Q: 视频播放不同步？**  
A: 
1. 检查网络连接是否稳定
2. 刷新页面重新连接
3. 查看服务器日志是否有错误

### 弹幕和聊天

**Q: 弹幕和聊天是联动的吗？**  
A: 是的！聊天消息会自动显示为金色弹幕，弹幕也会同步到聊天区。

**Q: 如何关闭弹幕？**  
A: 在播放器设置中可以开关弹幕显示。

### 部署相关

**Q: 如何在生产环境部署？**  
A: 推荐使用 PM2 或 Docker。详见[部署](#-部署)章节。

**Q: 重启后上传的文件会丢失吗？**  
A: 是的。项目采用纯内存存储房间信息，重启后所有房间数据和上传文件都会清除。如需持久化，建议：
1. 使用外部存储（如对象存储服务）
2. 定期备份 `uploads` 目录
3. 使用数据库存储房间信息

**Q: 支持 HTTPS 吗？**  
A: 应用本身不处理 SSL，建议在前面使用 Nginx 反向代理配置 HTTPS。

---

## 🤝 贡献

欢迎提交 Issue 或 Pull Request！

### 贡献指南

1. **Fork 项目**
   ```bash
   # Fork 后克隆到本地
   git clone https://github.com/YOUR_USERNAME/OnlineMediaPlayer.git
   cd OnlineMediaPlayer
   ```

2. **创建特性分支**
   ```bash
   git checkout -b feature/amazing-feature
   ```

3. **提交更改**
   ```bash
   git add .
   git commit -m 'Add some amazing feature'
   ```

4. **推送分支**
   ```bash
   git push origin feature/amazing-feature
   ```

5. **创建 Pull Request**

### 开发建议

- 遵循现有代码风格
- 添加必要的注释
- 测试你的更改
- 更新相关文档

### 报告问题

如果你发现 bug 或有功能建议，请[创建 Issue](https://github.com/Entropy-Xu/OnlineMediaPlayer/issues/new)。

---

## 🌟 致谢

感谢所有贡献者和使用者！

## 📞 联系方式

- 项目主页：[https://github.com/Entropy-Xu/OnlineMediaPlayer](https://github.com/Entropy-Xu/OnlineMediaPlayer)
- 问题反馈：[Issues](https://github.com/Entropy-Xu/OnlineMediaPlayer/issues)

---

## 📄 许可证

[GPL-3.0](LICENSE) - 自由使用、修改和分发，但必须保持开源。
