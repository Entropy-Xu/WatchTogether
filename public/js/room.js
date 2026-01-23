/**
 * 在线电影放映室 - 放映室逻辑
 */

// ==========================================
// 全局变量
// ==========================================

let socket = null;
let player = null;
let roomId = null;
let userName = null;
let isHost = false;
let isSyncing = false; // 防止同步循环
let danmakuEnabled = true; // 弹幕开关
let danmakuSpeed = 10; // 弹幕速度 (秒)

// ==========================================
// 工具函数
// ==========================================

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;

    setTimeout(() => {
        toast.className = 'toast';
    }, 3000);
}

function showNotification(message) {
    const notification = document.getElementById('notification');
    notification.textContent = message;
    notification.className = 'notification show';

    setTimeout(() => {
        notification.className = 'notification';
    }, 4000);
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function getInitial(name) {
    return name ? name.charAt(0).toUpperCase() : '?';
}

function showConnectionOverlay(show, text = '正在连接...') {
    const overlay = document.getElementById('connection-overlay');
    const statusText = document.getElementById('connection-status-text');

    statusText.textContent = text;
    overlay.className = show ? 'connection-overlay show' : 'connection-overlay';
}

function updateSyncStatus(status, text) {
    const syncStatus = document.getElementById('sync-status');
    const syncText = syncStatus.querySelector('.sync-text');

    syncStatus.className = `sync-status ${status}`;
    syncText.textContent = text;
}

// ==========================================
// 初始化
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
    // 从 URL 和 sessionStorage 获取信息
    const urlParams = new URLSearchParams(window.location.search);
    roomId = urlParams.get('id') || sessionStorage.getItem('roomId');
    userName = sessionStorage.getItem('userName');

    // 邀请链接逻辑：如果没有 roomId，回首页
    if (!roomId) {
        alert('请先从首页进入放映室');
        window.location.href = '/';
        return;
    }

    document.getElementById('room-id-display').textContent = roomId;

    // 邀请链接逻辑：如果有 roomId 但没有 userName，显示加入弹窗
    if (!userName) {
        const modal = document.getElementById('join-modal');
        const nameInput = document.getElementById('join-name-input');
        const joinBtn = document.getElementById('join-btn');

        modal.style.display = 'flex';

        const joinAction = () => {
            const name = nameInput.value.trim();
            if (name) {
                userName = name;
                sessionStorage.setItem('userName', name);
                sessionStorage.setItem('roomId', roomId);
                modal.style.display = 'none';
                startRoom();
            } else {
                alert('请输入昵称');
            }
        };

        joinBtn.addEventListener('click', joinAction);
        nameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') joinAction();
        });
    } else {
        startRoom();
    }
});

function startRoom() {
    isHost = sessionStorage.getItem('isHost') === 'true'; // 重新获取可能更新的状态
    initSocket();
    initVideoPlayer();
    initEventListeners();
    initDanmakuControl();
}

// ==========================================
// Socket.io 连接
// ==========================================

function initSocket() {
    showConnectionOverlay(true, '正在连接服务器...');

    socket = io();

    socket.on('connect', () => {
        console.log('Socket 已连接');
        joinRoom();
    });

    socket.on('disconnect', () => {
        console.log('Socket 已断开');
        updateSyncStatus('error', '已断开');
        showNotification('连接已断开，正在重连...');
    });

    socket.on('reconnect', () => {
        console.log('Socket 已重连');
        joinRoom();
    });

    // 用户加入
    socket.on('user-joined', ({ userName: name, userList }) => {
        showNotification(`${name} 加入了放映室`);
        updateUserList(userList);
        addSystemMessage(`${name} 加入了放映室`);
    });

    // 用户离开
    socket.on('user-left', ({ userName: name, userList }) => {
        showNotification(`${name} 离开了放映室`);
        updateUserList(userList);
        addSystemMessage(`${name} 离开了放映室`);
    });

    // 视频更换
    socket.on('video-changed', ({ url, changedBy }) => {
        loadVideo(url);
        showNotification(`${changedBy} 更换了视频`);
        addSystemMessage(`${changedBy} 更换了视频`);
    });

    // 字幕更换
    socket.on('subtitle-changed', ({ url, filename, changedBy }) => {
        setSubtitle(url);
        showNotification(`${changedBy} 加载了字幕: ${filename}`);
        addSystemMessage(`${changedBy} 加载了字幕: ${filename}`);
    });

    // 字幕轨道同步
    socket.on('sync-subtitle-track', ({ trackIndex }) => {
        if (!player) return;
        isSyncing = true;
        const tracks = player.textTracks();

        for (let i = 0; i < tracks.length; i++) {
            if (i === trackIndex) {
                tracks[i].mode = 'showing';
            } else {
                tracks[i].mode = 'disabled';
            }
        }

        setTimeout(() => isSyncing = false, 500);
    });

    // 同步播放
    socket.on('sync-play', ({ currentTime, triggeredBy }) => {
        if (!player) return;

        isSyncing = true;
        updateSyncStatus('syncing', '同步中...');

        const timeDiff = Math.abs(player.currentTime() - currentTime);
        if (timeDiff > 1) {
            player.currentTime(currentTime);
        }
        player.play();

        setTimeout(() => {
            isSyncing = false;
            updateSyncStatus('', '已同步');
        }, 500);

        showNotification(`${triggeredBy} 播放了视频`);
    });

    // 同步暂停
    socket.on('sync-pause', ({ currentTime, triggeredBy }) => {
        if (!player) return;

        isSyncing = true;
        updateSyncStatus('syncing', '同步中...');

        player.currentTime(currentTime);
        player.pause();

        setTimeout(() => {
            isSyncing = false;
            updateSyncStatus('', '已同步');
        }, 500);

        showNotification(`${triggeredBy} 暂停了视频`);
    });

    // 同步跳转
    socket.on('sync-seek', ({ currentTime, triggeredBy }) => {
        if (!player) return;

        isSyncing = true;
        updateSyncStatus('syncing', '同步中...');

        player.currentTime(currentTime);

        setTimeout(() => {
            isSyncing = false;
            updateSyncStatus('', '已同步');
        }, 500);

        showNotification(`${triggeredBy} 调整了进度`);
    });

    // 强制同步
    socket.on('force-sync', ({ videoUrl, videoState }) => {
        if (videoUrl) {
            loadVideo(videoUrl);

            setTimeout(() => {
                if (player && videoState) {
                    player.currentTime(videoState.currentTime);
                    if (videoState.isPlaying) {
                        player.play();
                    }
                }
            }, 1000);
        }
    });

    // 聊天消息
    socket.on('new-message', (message) => {
        addChatMessage(message);
        // 发送弹幕
        if (typeof danmakuManager !== 'undefined') {
            danmakuManager.add(message.text);
        }
    });
}

function joinRoom() {
    showConnectionOverlay(true, '正在加入放映室...');

    socket.emit('join-room', { roomId, userName }, (response) => {
        if (response.success) {
            showConnectionOverlay(false);
            updateSyncStatus('', '已同步');
            updateUserList(response.userList);

            // 加载现有视频
            if (response.videoUrl) {
                document.getElementById('video-url-input').value = response.videoUrl;
                loadVideo(response.videoUrl);

                // 加载字幕
                if (response.subtitleUrl) {
                    // 延迟加载字幕确保播放器已就绪
                    setTimeout(() => {
                        setSubtitle(response.subtitleUrl);
                    }, 500);
                }

                // 同步到当前进度
                setTimeout(() => {
                    if (player && response.videoState) {
                        player.currentTime(response.videoState.currentTime);
                        if (response.videoState.isPlaying) {
                            player.play();
                        }
                    }
                }, 1000);
            }

            // 加载聊天记录
            if (response.messages && response.messages.length > 0) {
                response.messages.forEach(msg => addChatMessage(msg, false));
            }

            showToast(`已加入放映室 ${roomId}`, 'success');
        } else {
            showConnectionOverlay(false);
            alert(response.error || '加入房间失败');
            window.location.href = '/';
        }
    });
}

// ==========================================
// Video.js 播放器
// ==========================================

function initVideoPlayer() {
    const videoElement = document.getElementById('video-player');

    player = videojs(videoElement, {
        controls: true,
        autoplay: false,
        preload: 'auto',
        fluid: false,
        responsive: true,
        playbackRates: [0.5, 1, 1.25, 1.5, 2],
        html5: {
            vhs: {
                overrideNative: true
            },
            nativeAudioTracks: false,
            nativeVideoTracks: false
        },
        controlBar: {
            children: [
                'playToggle',
                'volumePanel',
                'currentTimeDisplay',
                'timeDivider',
                'durationDisplay',
                'progressControl',
                'audioTrackButton', // 多声道支持
                'subsCapsButton',
                'qualitySelector',
                'fullscreenToggle',
            ]
        }
    });

    // 播放事件
    player.on('play', () => {
        if (isSyncing) return;
        socket.emit('video-play', { currentTime: player.currentTime() });
    });

    // 暂停事件
    player.on('pause', () => {
        if (isSyncing) return;
        // 排除视频结束时的暂停
        if (player.ended()) return;
        socket.emit('video-pause', { currentTime: player.currentTime() });
    });

    // 跳转事件
    player.on('seeked', () => {
        if (isSyncing) return;
        socket.emit('video-seek', { currentTime: player.currentTime() });
    });

    player.on('error', () => {
        showToast('视频加载失败，请检查链接是否有效', 'error');
    });

    // 修复：将弹幕容器移动到 Video.js 容器内，以便全屏时显示
    const dmContainer = document.getElementById('danmaku-container');
    if (dmContainer) {
        player.el().appendChild(dmContainer);
    }
}

function loadVideo(url, startTime = 0, autoPlay = false) {
    if (!player || !url) return;

    // 隐藏占位符，显示播放器
    document.getElementById('video-placeholder').style.display = 'none';
    document.getElementById('video-player').style.display = 'block';
    document.getElementById('video-hint').style.display = 'flex';

    // 根据 URL 扩展名判断视频类型
    const urlLower = url.toLowerCase();
    let type = 'video/mp4'; // 默认

    // MIME 类型映射
    const mimeMap = {
        '.mp4': 'video/mp4',
        '.m4v': 'video/mp4',
        '.mov': 'video/mp4',
        '.webm': 'video/webm',
        '.ogg': 'video/ogg',
        '.ogv': 'video/ogg',
        '.mkv': 'video/mp4',
        '.avi': 'video/mp4',
        '.flv': 'video/mp4',
        '.wmv': 'video/mp4',
        '.m3u8': 'application/x-mpegURL',
        '.mpd': 'application/dash+xml',
        '.ts': 'video/mp2t'
    };

    // 查找匹配的扩展名
    for (const [ext, mime] of Object.entries(mimeMap)) {
        if (urlLower.includes(ext)) {
            type = mime;
            break;
        }
    }

    isSyncing = true;

    // 清除旧的 HLS 实例
    if (player.hlsInstance) {
        player.hlsInstance.destroy();
        player.hlsInstance = null;
    }

    // 先重置播放器
    player.reset();

    // HLS 处理 (使用 hls.js 库)
    if (type === 'application/x-mpegURL' && typeof Hls !== 'undefined' && Hls.isSupported()) {
        console.log('使用 hls.js 加载 HLS 流');

        const videoElement = player.tech({ IWillNotUseThisInPlugins: true }).el();
        const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false
        });

        hls.loadSource(url);
        hls.attachMedia(videoElement);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            console.log('HLS 清单已解析，音轨数量:', hls.audioTracks.length);

            // 创建音轨选择器 UI
            if (hls.audioTracks.length > 1) {
                createAudioTrackSelector(hls);
            }

            if (startTime > 0) {
                player.currentTime(startTime);
            }

            if (autoPlay) {
                player.play().catch(e => {
                    console.log('自动播放被拦截:', e);
                    showToast('请点击播放开始观看', 'info');
                });
            }

            updateSyncStatus('', '已同步');
            setTimeout(() => { isSyncing = false; }, 1000);
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
            console.error('HLS 错误:', data);
            if (data.fatal) {
                showToast('视频加载失败', 'error');
                isSyncing = false;
            }
        });

        // 存储 hls 实例以便后续操作
        player.hlsInstance = hls;

    } else {
        // 非 HLS 或 Safari 原生支持
        player.src({
            src: url,
            type: type
        });

        player.load();

        player.one('loadedmetadata', () => {
            console.log('视频元数据已加载，准备跳转');

            if (startTime > 0) {
                player.currentTime(startTime);
            }

            if (autoPlay) {
                const playPromise = player.play();
                if (playPromise !== undefined) {
                    playPromise.catch(error => {
                        console.log("自动播放被拦截 (需用户交互):", error);
                        showToast('请点击播放开始观看', 'info');
                    });
                }
            }

            updateSyncStatus('', '已同步');

            setTimeout(() => {
                isSyncing = false;
            }, 1000);
        });

        player.one('error', (e) => {
            console.error('视频加载错误:', player.error());
            showToast('视频加载失败，可能是格式不支持或编码不兼容', 'error');
            isSyncing = false;
        });
    }
}

// ==========================================
// UI 事件监听
// ==========================================

function initEventListeners() {
    // 复制房间号
    document.getElementById('copy-room-id').addEventListener('click', () => {
        navigator.clipboard.writeText(roomId).then(() => {
            showToast('房间号已复制', 'success');
        }).catch(() => {
            // 降级方案
            const input = document.createElement('input');
            input.value = roomId;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            showToast('房间号已复制', 'success');
        });
    });

    // 加载视频
    document.getElementById('load-video-btn').addEventListener('click', () => {
        const url = document.getElementById('video-url-input').value.trim();
        if (!url) {
            showToast('请输入视频链接', 'error');
            return;
        }

        // 简单的 URL 验证
        try {
            new URL(url);
        } catch {
            showToast('请输入有效的视频链接', 'error');
            return;
        }

        socket.emit('change-video', { url });
    });

    // 回车加载视频
    document.getElementById('video-url-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('load-video-btn').click();
        }
    });

    // 文件上传按钮点击
    document.getElementById('upload-video-btn').addEventListener('click', () => {
        document.getElementById('video-file-input').click();
    });

    // 文件选择处理
    document.getElementById('video-file-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // 使用扩展名检查文件类型（因为 MKV 等格式的 MIME 类型可能无法识别）
        const allowedExtensions = /\.(mp4|m4v|mov|webm|ogg|ogv|mkv|avi|flv|wmv|ts)$/i;
        if (!allowedExtensions.test(file.name) && !file.type.startsWith('video/')) {
            showToast('请选择视频文件 (支持 MP4, MKV, FLV, AVI, MOV 等)', 'error');
            return;
        }

        uploadVideo(file);
    });

    // 字幕上传按钮点击
    document.getElementById('upload-subtitle-btn').addEventListener('click', () => {
        document.getElementById('subtitle-file-input').click();
    });

    // 字幕文件选择处理
    document.getElementById('subtitle-file-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const allowedExtensions = /\.(srt|ass|ssa|sub|idx)$/i;
        if (!allowedExtensions.test(file.name)) {
            showToast('请选择字幕文件 (srt, ass, sub, idx)', 'error');
            return;
        }

        uploadSubtitle(file);
    });

    // 发送聊天消息
    document.getElementById('chat-form').addEventListener('submit', (e) => {
        e.preventDefault();

        const input = document.getElementById('chat-input');
        const text = input.value.trim();

        if (!text) return;

        socket.emit('chat-message', { text });
        input.value = '';
    });
}

// ==========================================
// 视频/字幕上传
// ==========================================

function setSubtitle(url) {
    if (!player || !url) return;

    // 清除现有字幕
    const tracks = player.remoteTextTracks();
    for (let i = tracks.length - 1; i >= 0; i--) {
        player.removeRemoteTextTrack(tracks[i]);
    }

    // 添加新字幕
    player.addRemoteTextTrack({
        kind: 'subtitles',
        src: url,
        label: 'Upload',
        srclang: 'zh',
        default: true
    }, false);

    // 强制显示字幕
    // Video.js 即使设置了 default: true，有时也需要手动设置为 showing
    setTimeout(() => {
        const textTracks = player.textTracks();
        for (let i = 0; i < textTracks.length; i++) {
            if (textTracks[i].kind === 'subtitles' && textTracks[i].label === 'Upload') {
                textTracks[i].mode = 'showing';
            } else {
                textTracks[i].mode = 'disabled';
            }
        }
    }, 100);

    showToast('字幕已加载', 'success');
}

function uploadSubtitle(file) {
    const uploadBtn = document.getElementById('upload-subtitle-btn');

    // 简单 loading 状态
    const originalText = uploadBtn.querySelector('span').textContent;
    uploadBtn.disabled = true;
    uploadBtn.querySelector('span').textContent = '转换中...';

    const formData = new FormData();
    formData.append('video', file); // 复用 multer 'video' 字段

    fetch('/api/upload', {
        method: 'POST',
        body: formData
    })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                showToast(`字幕 "${data.filename}" 上传成功`, 'success');
                // 通知服务器更换字幕
                socket.emit('change-subtitle', {
                    url: data.url,
                    filename: data.filename
                });
            } else {
                showToast(data.error || '字幕上传失败', 'error');
            }
        })
        .catch(err => {
            console.error(err);
            showToast('网络错误，上传失败', 'error');
        })
        .finally(() => {
            uploadBtn.disabled = false;
            uploadBtn.querySelector('span').textContent = originalText;
            document.getElementById('subtitle-file-input').value = '';
        });
}

function uploadVideo(file) {
    const uploadBtn = document.getElementById('upload-video-btn');
    const uploadProgress = document.getElementById('upload-progress');
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const transcodeOverlay = document.getElementById('transcode-overlay');

    // 禁用上传按钮
    uploadBtn.disabled = true;
    uploadBtn.querySelector('span:last-child').textContent = '上传中...';

    // 显示进度条
    uploadProgress.style.display = 'flex';
    progressFill.style.width = '0%';
    progressText.textContent = '准备上传...';

    const formData = new FormData();
    formData.append('video', file);

    const xhr = new XMLHttpRequest();

    // 上传进度
    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            progressFill.style.width = `${percent}%`;
            progressText.textContent = `上传中... ${percent}%`;

            // 上传完成后显示转码提示
            if (percent === 100) {
                progressText.textContent = '上传完成，等待服务器处理...';
                transcodeOverlay.style.display = 'flex';
            }
        }
    });

    // 上传完成
    xhr.addEventListener('load', () => {
        // 隐藏转码提示
        transcodeOverlay.style.display = 'none';

        if (xhr.status === 200) {
            try {
                const response = JSON.parse(xhr.responseText);
                if (response.success) {
                    progressFill.style.width = '100%';
                    progressText.textContent = '处理完成！';
                    showToast(`视频 "${response.filename}" 上传成功`, 'success');

                    // 通知所有人更换视频
                    socket.emit('change-video', { url: response.url });

                    // 隐藏进度条
                    setTimeout(() => {
                        uploadProgress.style.display = 'none';
                    }, 2000);
                } else {
                    showToast(response.error || '上传失败', 'error');
                    uploadProgress.style.display = 'none';
                }
            } catch {
                showToast('上传响应解析失败', 'error');
                uploadProgress.style.display = 'none';
            }
        } else {
            showToast('上传失败，请重试', 'error');
            uploadProgress.style.display = 'none';
        }

        // 恢复按钮状态
        uploadBtn.disabled = false;
        uploadBtn.querySelector('span:last-child').textContent = '上传文件';
    });

    // 上传错误
    xhr.addEventListener('error', () => {
        showToast('网络错误，上传失败', 'error');
        uploadProgress.style.display = 'none';
        transcodeOverlay.style.display = 'none';
        uploadBtn.disabled = false;
        uploadBtn.querySelector('span:last-child').textContent = '上传文件';
    });

    // 发送请求
    xhr.open('POST', '/api/upload');
    xhr.send(formData);
}

// ==========================================
// 用户列表
// ==========================================

function updateUserList(users) {
    const userList = document.getElementById('user-list');
    const userCount = document.getElementById('user-count').querySelector('.count');

    userCount.textContent = users.length;

    userList.innerHTML = users.map(user => `
    <li>
      <div class="user-avatar">${getInitial(user.name)}</div>
      <span class="user-name">${escapeHtml(user.name)}</span>
      ${user.isHost ? '<span class="host-badge" title="房主 (管理员)"><i class="fa-solid fa-crown"></i></span>' : ''}
    </li>
  `).join('');
}

// ==========================================
// 邀请功能
// ==========================================
function copyInviteLink() {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
        showToast('邀请链接已复制', 'success');
    }).catch(() => {
        // 降级方案
        const input = document.createElement('input');
        input.value = url;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        showToast('邀请链接已复制', 'success');
    });
}

// ==========================================
// 聊天功能
// ==========================================

function addChatMessage(message, scroll = true) {
    const chatMessages = document.getElementById('chat-messages');

    // 移除欢迎消息
    const welcome = chatMessages.querySelector('.chat-welcome');
    if (welcome) {
        welcome.remove();
    }

    const messageEl = document.createElement('div');
    messageEl.className = 'chat-message';
    messageEl.innerHTML = `
    <div class="message-header">
      <span class="message-author">${escapeHtml(message.userName)}</span>
      <span class="message-time">${formatTime(message.timestamp)}</span>
    </div>
    <div class="message-text">${escapeHtml(message.text)}</div>
  `;

    chatMessages.appendChild(messageEl);

    if (scroll) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

function addSystemMessage(text) {
    const chatMessages = document.getElementById('chat-messages');

    const messageEl = document.createElement('div');
    messageEl.className = 'system-message';
    messageEl.textContent = text;

    chatMessages.appendChild(messageEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ==========================================
// 弹幕功能
// ==========================================

class DanmakuManager {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.tracks = [0, 1, 2, 3, 4]; // 轨道数
        this.trackHeight = 40; // 轨道高度
    }

    add(text, color = '#ffffff') {
        if (!danmakuEnabled || !this.container) return;

        const item = document.createElement('div');
        item.className = 'danmaku-item';
        item.textContent = text;
        item.style.color = color;

        // 随机分配轨道
        const track = Math.floor(Math.random() * this.tracks.length);
        const top = track * this.trackHeight + 20; // 20px padding
        item.style.top = `${top}px`;

        // 设置初始位置
        item.style.left = '100%';
        item.style.transform = 'translateX(0)';

        this.container.appendChild(item);

        // 动画
        const duration = 8000 + Math.random() * 4000; // 8-12秒

        // 使用 Web Animations API
        const animation = item.animate([
            { transform: 'translateX(0)', left: '100%' },
            { transform: 'translateX(-100%)', left: '-100px' } // 移出屏幕
        ], {
            duration: duration,
            easing: 'linear'
        });

        animation.onfinish = () => {
            item.remove();
        };
    }

    clear() {
        if (this.container) {
            this.container.innerHTML = '';
        }
    }
}

const danmakuManager = new DanmakuManager('danmaku-container');

// 初始化弹幕开关
function initDanmakuControl() {
    const btn = document.getElementById('toggle-danmaku-btn');
    if (!btn) return;

    btn.addEventListener('click', () => {
        danmakuEnabled = !danmakuEnabled;

        if (danmakuEnabled) {
            btn.classList.add('active');
            btn.querySelector('span').textContent = '弹幕: 开';
            document.getElementById('danmaku-container').style.opacity = '1';
        } else {
            btn.classList.remove('active');
            btn.querySelector('span').textContent = '弹幕: 关';
            document.getElementById('danmaku-container').style.opacity = '0';
        }
    });
}

// ==========================================
// 安全函数
// ==========================================

// ==========================================
// 音轨选择器 (HLS.js)
// ==========================================

function createAudioTrackSelector(hls) {
    // 移除旧的选择器
    const oldSelector = document.querySelector('.audio-track-selector');
    if (oldSelector) oldSelector.remove();

    const controlBar = player.controlBar.el();

    // 创建音轨按钮容器
    const container = document.createElement('div');
    container.className = 'vjs-menu-button vjs-menu-button-popup vjs-control vjs-button audio-track-selector';

    // 按钮
    const button = document.createElement('button');
    button.className = 'vjs-menu-button vjs-button';
    button.type = 'button';
    button.title = '音轨选择';
    button.innerHTML = '<i class="fa-solid fa-volume-high"></i>';

    // 菜单
    const menu = document.createElement('div');
    menu.className = 'vjs-menu audio-track-menu';

    const menuContent = document.createElement('ul');
    menuContent.className = 'vjs-menu-content';

    // 添加音轨选项
    hls.audioTracks.forEach((track, index) => {
        const item = document.createElement('li');
        item.className = 'vjs-menu-item' + (index === hls.audioTrack ? ' vjs-selected' : '');
        item.textContent = track.name || `音轨 ${index + 1}`;
        item.dataset.index = index;

        item.addEventListener('click', () => {
            hls.audioTrack = index;
            // 更新选中状态
            menuContent.querySelectorAll('.vjs-menu-item').forEach(el => el.classList.remove('vjs-selected'));
            item.classList.add('vjs-selected');
            showToast(`已切换到: ${track.name || '音轨 ' + (index + 1)}`, 'success');
        });

        menuContent.appendChild(item);
    });

    menu.appendChild(menuContent);
    container.appendChild(button);
    container.appendChild(menu);

    // 插入到全屏按钮之前
    const fullscreenBtn = controlBar.querySelector('.vjs-fullscreen-control');
    if (fullscreenBtn) {
        controlBar.insertBefore(container, fullscreenBtn);
    } else {
        controlBar.appendChild(container);
    }

    console.log('音轨选择器已创建，共', hls.audioTracks.length, '个音轨');
}

// ==========================================
// 工具函数
// ==========================================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==========================================
// 页面离开前清理
// ==========================================

window.addEventListener('beforeunload', () => {
    if (socket) {
        socket.disconnect();
    }
    if (player) {
        player.dispose();
    }
});

console.log('🎬 放映室已加载');
