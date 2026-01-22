# 🎬 Online Media Player (在线电影放映室)

一个极简、现代化的在线电影同步放映室。邀请朋友，共享观影时光。

![](public/favicon.ico) *（此处可放项目截图）*

## ✨ 核心特性 (Key Features)

### 💎 极致体验
-   **沉浸式 UI**: 采用 Glassmorphism（玻璃拟态）设计风格，提供深色影院模式。
-   **全平台适配**: 完美支持桌面端、平板（iPad）及移动端设备，横竖屏自动优化。
-   **实时弹幕**: 支持 Bilibili 风格的实时弹幕互动（Danmaku），让交流更有趣。

### 🚀 高性能播放
-   **多格式支持**: 支持 MP4, MKV, MOV, HLS (m3u8), DASH 等主流视频格式。
-   **秒开优化 (Fast Start)**: 服务器自动使用 FFmpeg 优化视频元数据，实现大文件边下边播，无需等待下载完成。
-   **毫秒级同步**: 基于 Socket.io 的精准同步算法，确保每一秒都与朋友神同步。

### �️ 便捷功能
-   **一键建房**: 无需注册，输入昵称即可创建或加入房间。
-   **本地/网络源**: 支持粘贴外部直链或直接上传本地视频文件。
-   **即时聊天**: 内置实时聊天室，无需切换软件即可交流。

## 🛠️ 技术栈 (Tech Stack)

-   **Frontend**: HTML5, CSS3 (Vanilla + Variables), JavaScript (ES6+), FontAwesome v6
-   **Backend**: Node.js, Express
-   **Real-time**: Socket.io v4
-   **Media Processing**: FFmpeg, Multer
-   **No Database**: 纯内存存储房间状态，轻量且隐私安全（重启即销毁）。

## 📦 环境要求 (Prerequisites)

-   **Node.js**: v16.0.0 或更高版本
-   **FFmpeg**: 用于视频转码和元数据优化（**必须安装**，否则大文件加载慢）

### 安装 FFmpeg
-   **macOS**: `brew install ffmpeg`
-   **Ubuntu/Debian**: `sudo apt install ffmpeg`
-   **CentOS**: `yum install ffmpeg`
-   **Windows**: 下载 FFmpeg 二进制文件并配置环境变量

## 🚀 快速开始 (Quick Start)

1.  **克隆项目**
    ```bash
    git clone https://github.com/YOUR_USERNAME/online-media-player.git
    cd online-media-player
    ```

2.  **安装依赖**
    ```bash
    npm install
    ```

3.  **启动开发服务器**
    ```bash
    npm run dev
    # 或者生产模式
    npm start
    ```

4.  **访问**
    -   打开浏览器访问: `http://localhost:3000`

## 🐳 部署指南 (Deployment)

### 宝塔面板 (Baota Panel)
本项目提供了详细的宝塔面板部署指南，涵盖了 Nginx WebSocket 配置和 FFmpeg 安装。
👉 **[点击查看宝塔部署教程 (DEPLOY_BAOTA.md)](DEPLOY_BAOTA.md)**

### Docker (可选)
*（待补充 Dockerfile）*

## 🔧 常见问题 (FAQ)

**Q: 为什么上传 1GB 以上的大文件加载很慢？**
A: 请确保服务器已安装 `ffmpeg`。项目会自动检测并进行 Fast Start 优化（移动 Moov Atom），这通常能解决加载慢的问题。

**Q: 是否支持多人同时观看？**
A: 是的，这也是本项目的核心功能。任一人操作播放/暂停/跳转，所有人都会同步。

**Q: 视频上传有限制吗？**
A: 默认不限制大小，但需注意 Nginx 反向代理配置中的 `client_max_body_size` 限制。

## 🤝 贡献 (Contributing)
欢迎提交 Issue 或 Pull Request 来改进这个项目！

## 📄 许可证 (License)
本项目采用 [GPL-3.0](LICENSE) 许可证。
您可以自由使用、修改和分发，但必须保持开源。
