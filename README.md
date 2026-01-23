# 🎬 Online Media Player (在线电影放映室)

一个极简、现代化的在线电影同步放映室。邀请朋友，共享观影时光。

![preview](https://github.com/user-attachments/assets/46691c24-d448-48ab-ba28-b914c46bd08e)

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

```bash
# 1. 克隆项目
git clone https://github.com/Entropy-Xu/OnlineMediaPlayer.git
cd OnlineMediaPlayer

# 2. 安装依赖
npm install

# 3. 启动服务器
npm start
# 或开发模式
npm run dev

# 4. 访问
# http://localhost:3000
```

## 🐳 部署

### 宝塔面板
详细部署指南请查看 👉 **[DEPLOY_BAOTA.md](DEPLOY_BAOTA.md)**

### Docker
*（待补充）*

## ❓ 常见问题

**Q: 上传大文件加载很慢？**  
A: 确保已安装 FFmpeg。项目会自动进行 HLS 转码和并行分片处理。

**Q: 支持多人同时观看吗？**  
A: 是的！任何人的播放/暂停/跳转操作都会同步到所有观众。

**Q: 视频上传有大小限制吗？**  
A: 默认无限制，但需注意 Nginx 的 `client_max_body_size` 配置。

**Q: 弹幕和聊天是联动的吗？**  
A: 是的！聊天消息会显示为金色弹幕，弹幕也会同步到聊天区。

## 🤝 贡献

欢迎提交 Issue 或 Pull Request！

## 📄 许可证

[GPL-3.0](LICENSE) - 自由使用、修改和分发，但必须保持开源。
