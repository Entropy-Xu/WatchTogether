# 🎬 Online Media Player

<div align="center">

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org/)
[![Socket.io](https://img.shields.io/badge/Socket.io-v4-orange)](https://socket.io/)

English | [简体中文](./README.md)

A minimalist, modern online synchronized movie theater. Invite friends and share the joy of watching together.

![preview](https://github.com/user-attachments/assets/46691c24-d448-48ab-ba28-b914c46bd08e)

[Features](#-core-features) •
[Quick Start](#-quick-start) •
[Deployment](#-deployment) •
[FAQ](#-faq) •
[Contributing](#-contributing)

</div>

---

## 📖 Table of Contents

- [Core Features](#-core-features)
- [Tech Stack](#️-tech-stack)
- [Requirements](#-requirements)
- [Quick Start](#-quick-start)
- [Usage Guide](#-usage-guide)
- [Configuration](#️-configuration)
- [Deployment](#-deployment)
- [Project Structure](#-project-structure)
- [FAQ](#-faq)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Core Features

### 💎 Ultimate Experience
- **Immersive UI**: Glassmorphism design with dark cinema mode
- **Cross-Platform**: Desktop, tablet (iPad), and mobile support
- **Real-time Danmaku**: Bilibili-style bullet comments synced with chat
- **Custom Player**: Fully customizable controls with playback speed, volume, fullscreen, etc.

### 🚀 High-Performance Playback
- **Multi-Format Support**: MP4, MKV, MOV, AVI, FLV, HLS (m3u8), DASH, etc.
- **HLS Multi-Audio**: Auto-convert to HLS with multi-track audio support
- **Subtitle Support**: Upload and switch between SRT, ASS, SSA subtitles
- **Parallel Transcoding**: Large files auto-split for parallel processing
- **Millisecond Sync**: Precise synchronization powered by Socket.io

### 🎛️ Playback Controls
- **Speed Control**: 0.5x ~ 2.0x playback speed
- **Audio Track Switching**: Select audio tracks in HLS videos
- **Subtitle Selection**: Toggle and switch uploaded subtitles
- **Fullscreen Mode**: Auto-hide UI, show on mouse movement

### 💬 Interactive Features
- **Real-time Chat**: Built-in chat room, no need to switch apps
- **Danmaku System**: Scrolling comments above video, synced with chat
- **Room Management**: Host controls permissions (video switching, subtitles, playback control)

## 🛠️ Tech Stack

| Category | Technology |
|----------|-----------|
| Frontend | HTML5, CSS3, JavaScript ES6+, FontAwesome v6 |
| Backend | Node.js, Express |
| Real-time | Socket.io v4 |
| Media | FFmpeg (parallel transcoding), HLS.js, Video.js |
| Storage | In-memory (cleared on restart) |

## 📦 Requirements

- **Node.js**: v16.0.0+
- **FFmpeg**: Required (for video transcoding)

### Installing FFmpeg
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt update && sudo apt install ffmpeg -y

# CentOS/RHEL
sudo yum install epel-release -y
sudo yum install ffmpeg -y

# Windows (using Chocolatey)
choco install ffmpeg
```

Verify installation: `ffmpeg -version`

## 🚀 Quick Start

### Prerequisites
Ensure your system has:
- **Node.js** v16.0.0 or higher
- **FFmpeg** (for video transcoding)

### Installation Steps

```bash
# 1. Clone the repository
git clone https://github.com/Entropy-Xu/OnlineMediaPlayer.git
cd OnlineMediaPlayer

# 2. Install dependencies
npm install

# 3. Start the server
npm start
# Or in development mode (auto-restart)
npm run dev

# 4. Access the application
# Open your browser and visit: http://localhost:3000
```

The server runs on `http://localhost:3000` by default. You can customize the port via the `PORT` environment variable.

---

## 📚 Usage Guide

### Creating a Room
1. Open the homepage at `http://localhost:3000`
2. Enter your nickname in the "Create Room" card
3. Click the "Create Room" button
4. The system will generate an 8-character room ID to share with friends

### Joining a Room
1. Open the homepage
2. Enter your nickname and the room ID in the "Join Room" card
3. Click the "Join Room" button

### Uploading Videos
1. In the room, click the "Select Video" button
2. Choose a local video file (supports MP4, MKV, MOV, AVI, FLV, etc.)
3. Wait for upload and transcoding to complete (large files auto-convert to HLS)
4. The video will automatically sync to all viewers

### Uploading Subtitles
1. Click the "Upload Subtitle" button
2. Choose a subtitle file (supports SRT, ASS, SSA formats)
3. After upload, you can toggle subtitles in the player

### Permission Control
- **Host Permissions**: Default full control (video switching, subtitles, playback)
- **Permission Settings**: Host can adjust permissions via settings button
  - Allow/disallow others to switch videos
  - Allow/disallow others to switch subtitles
  - Allow/disallow others to control playback

### Real-time Interaction
- **Chat**: Type messages in the right-side chat box and send
- **Danmaku**: Chat messages appear as golden bullet comments on the video
- **Synchronized Playback**: Any play/pause/seek action syncs to all viewers

---

## ⚙️ Configuration

### Environment Variables

Customize server configuration with environment variables:

```bash
# Custom port (default: 3000)
PORT=8080 npm start

# Or create a .env file
echo "PORT=8080" > .env
npm start
```

### File Upload Limits

By default, there's no file size limit. If using Nginx reverse proxy, configure:

```nginx
client_max_body_size 1024M;  # or larger
```

---

## 🐳 Deployment

### Option 1: Baota Panel
See detailed deployment guide 👉 **[DEPLOY_BAOTA.md](DEPLOY_BAOTA.md)** (Chinese)

### Option 2: Docker

#### Using Docker Compose (Recommended)

1. Create a `docker-compose.yml` file:

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

2. Start the service:

```bash
docker-compose up -d
```

#### Using Dockerfile

1. Create a `Dockerfile`:

```dockerfile
FROM node:18-alpine

# Install FFmpeg
RUN apk add --no-cache ffmpeg

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy project files
COPY . .

# Create upload directory
RUN mkdir -p uploads

# Expose port
EXPOSE 3000

# Start application
CMD ["npm", "start"]
```

2. Build and run:

```bash
# Build image
docker build -t online-media-player .

# Run container
docker run -d -p 3000:3000 --name media-player online-media-player
```

### Option 3: Traditional Deployment

1. Ensure server has Node.js and FFmpeg installed
2. Clone the project to server
3. Install dependencies: `npm install`
4. Use PM2 to manage the process:

```bash
# Install PM2
npm install -g pm2

# Start application
pm2 start server.js --name online-media-player

# Enable startup on boot
pm2 startup
pm2 save
```

### Reverse Proxy Configuration (Nginx)

If using Nginx as a reverse proxy, configure WebSocket support:

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
        
        # File upload size limit
        client_max_body_size 1024M;
    }
}
```

---

## 📁 Project Structure

```
OnlineMediaPlayer/
├── public/                 # Frontend static files
│   ├── index.html         # Homepage (create/join room)
│   ├── room.html          # Room page
│   ├── css/
│   │   └── style.css      # Stylesheet
│   └── js/
│       ├── app.js         # Homepage logic
│       └── room.js        # Room logic
├── uploads/               # Upload storage directory (created at runtime)
├── server.js              # Node.js server main file
├── package.json           # Project dependencies
├── README.md              # Project documentation (Chinese version)
├── README_EN.md           # Project documentation (English version)
└── DEPLOY_BAOTA.md        # Baota Panel deployment guide (Chinese)
```

### Core Modules

- **server.js**: Express server + Socket.io real-time communication + file upload handling + FFmpeg video transcoding
- **room.js**: Room management, video synchronization, chat, and danmaku features
- **app.js**: Room creation and joining logic

---

## ❓ FAQ

### Installation and Configuration

**Q: How to install FFmpeg?**  
A: 
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt update && sudo apt install ffmpeg -y

# CentOS/RHEL
sudo yum install epel-release -y
sudo yum install ffmpeg -y

# Windows (using Chocolatey)
choco install ffmpeg
```

Verify: `ffmpeg -version`

**Q: How to change the default port?**  
A: Use environment variable: `PORT=8080 npm start` or modify the `PORT` constant in `server.js`.

### Upload and Playback

**Q: Large file uploads are slow?**  
A: Ensure FFmpeg is installed. The project auto-performs HLS transcoding and parallel chunk processing. Large files (>100MB) are automatically split for faster processing.

**Q: What video formats are supported?**  
A: Nearly all common formats: MP4, MKV, MOV, AVI, FLV, WMV, WebM, OGV, etc. Non-standard formats are auto-converted to HLS.

**Q: Is there a file size limit for uploads?**  
A: The application itself has no limit, but consider:
- Nginx reverse proxy `client_max_body_size` configuration
- Server disk space
- Network bandwidth and upload time

**Q: Subtitles not showing?**  
A: 
1. Ensure subtitle file is UTF-8 encoded
2. Check if subtitle format is supported (SRT, ASS, SSA)
3. Try re-uploading the subtitle file

### Synchronization and Connection

**Q: Does it support multiple viewers simultaneously?**  
A: Yes! Any play/pause/seek action syncs to all viewers. Sync latency is typically in milliseconds.

**Q: WebSocket connection failed?**  
A: 
1. Check if firewall allows port access
2. If using reverse proxy, ensure WebSocket upgrade headers are configured correctly
3. Check browser console for error messages

**Q: Video playback not synchronized?**  
A: 
1. Check if network connection is stable
2. Refresh the page to reconnect
3. Check server logs for errors

### Danmaku and Chat

**Q: Are danmaku and chat linked?**  
A: Yes! Chat messages automatically display as golden danmaku, and danmaku syncs to the chat area.

**Q: How to disable danmaku?**  
A: You can toggle danmaku display in player settings.

### Deployment

**Q: How to deploy in production?**  
A: Recommend using PM2 or Docker. See [Deployment](#-deployment) section.

**Q: Will uploaded files be lost after restart?**  
A: Yes. The project uses pure in-memory storage for room information. All room data and uploaded files are cleared on restart. For persistence, consider:
1. Using external storage (like object storage services)
2. Regularly backing up the `uploads` directory
3. Using a database for room information

**Q: Does it support HTTPS?**  
A: The application doesn't handle SSL itself. Recommend using Nginx reverse proxy to configure HTTPS.

---

## 🤝 Contributing

Issues and Pull Requests are welcome!

### Contributing Guide

1. **Fork the project**
   ```bash
   # Clone your fork locally
   git clone https://github.com/YOUR_USERNAME/OnlineMediaPlayer.git
   cd OnlineMediaPlayer
   ```

2. **Create a feature branch**
   ```bash
   git checkout -b feature/amazing-feature
   ```

3. **Commit your changes**
   ```bash
   git add .
   git commit -m 'Add some amazing feature'
   ```

4. **Push the branch**
   ```bash
   git push origin feature/amazing-feature
   ```

5. **Create a Pull Request**

### Development Guidelines

- Follow existing code style
- Add necessary comments
- Test your changes
- Update relevant documentation

### Reporting Issues

If you find a bug or have a feature suggestion, please [create an Issue](https://github.com/Entropy-Xu/OnlineMediaPlayer/issues/new).

---

## 🌟 Acknowledgments

Thanks to all contributors and users!

## 📞 Contact

- Project Homepage: [https://github.com/Entropy-Xu/OnlineMediaPlayer](https://github.com/Entropy-Xu/OnlineMediaPlayer)
- Issue Tracker: [Issues](https://github.com/Entropy-Xu/OnlineMediaPlayer/issues)

---

## 📄 License

[GPL-3.0](LICENSE) - Free to use, modify, and distribute, but must remain open source.
