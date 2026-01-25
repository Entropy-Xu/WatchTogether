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
let roomSettings = {
    allowAllChangeVideo: false,
    allowAllChangeSubtitle: false,
    allowAllControl: true
};

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

function formatMessageTime(timestamp) {
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
    syncStatus.className = `sync-status ${status}`;
    syncText.textContent = text;
}

// 获取或生成用户 ID (用于重连恢复房主身份)
function getOrCreateUserId() {
    let id = localStorage.getItem('mediaplayer_userid');
    if (!id) {
        // 生成简单的 UUID
        id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
        localStorage.setItem('mediaplayer_userid', id);
    }
    return id;
}

// 更新播放器权限控制 UI
function updatePlayerControls() {
    const playerEl = document.getElementById('video-player');
    if (!playerEl) return;

    // 如果是房主，或者允许所有人控制，则启用控件
    const canControl = isHost || roomSettings.allowAllControl;

    if (canControl) {
        playerEl.classList.remove('controls-disabled');
    } else {
        playerEl.classList.add('controls-disabled');
    }

    console.log(`[Permission] 更新权限控制: isHost=${isHost}, allowControl=${roomSettings.allowAllControl} => disabled=${!canControl}`);
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

        modal.classList.add('show');

        const joinAction = () => {
            const name = nameInput.value.trim();
            if (name) {
                userName = name;
                sessionStorage.setItem('userName', name);
                sessionStorage.setItem('roomId', roomId);
                modal.classList.remove('show');
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
    // 不要在这里读取 isHost，等待服务器响应
    initSocket();
    initVideoPlayer();
    initEventListeners();
    initPermissionListeners();
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
    socket.on('video-changed', ({ url, mseData, changedBy }) => {
        loadVideo(url, mseData);
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

    // 转码进度
    socket.on('transcode-progress', (data) => {
        const transcodeOverlay = document.getElementById('transcode-overlay');
        const transcodeStatus = document.getElementById('transcode-status');
        const transcodeProgress = document.getElementById('transcode-progress-bar');
        const transcodeMessage = document.getElementById('transcode-message');

        if (!transcodeOverlay) return;

        // 显示转码覆盖层
        if (data.stage !== 'complete') {
            transcodeOverlay.style.display = 'flex';
        }

        // 更新状态文本
        const stageText = {
            'analyzing': '分析中',
            'transcoding': '转码中',
            'merging': '合并中',
            'complete': '完成',
            'error': '出错'
        };

        if (transcodeStatus) {
            let statusHtml = `<span class="stage">${stageText[data.stage] || data.stage}</span>`;
            if (data.segmentInfo) {
                statusHtml += ` <span class="segment-info">(${data.segmentInfo.completed}/${data.segmentInfo.total})</span>`;
            }
            transcodeStatus.innerHTML = statusHtml;
        }

        // 更新进度条
        if (transcodeProgress) {
            transcodeProgress.style.width = `${data.progress}%`;
            transcodeProgress.setAttribute('data-progress', `${data.progress}%`);
        }

        // 更新消息
        if (transcodeMessage) {
            transcodeMessage.textContent = data.message || '';
        }

        // 完成时隐藏
        if (data.stage === 'complete') {
            setTimeout(() => {
                transcodeOverlay.style.display = 'none';
            }, 1500);
        }

        console.log(`[转码进度] ${data.stage}: ${data.progress}% - ${data.message}`);
    });

    // B 站下载进度
    socket.on('bilibili-download-progress', (data) => {
        console.log('[B站下载] 收到进度事件:', data);

        const progressContainer = document.getElementById('bilibili-progress-container');
        const progressBar = document.getElementById('bilibili-progress-bar');
        const progressText = document.getElementById('bilibili-progress-text');
        const progressPercent = document.getElementById('bilibili-progress-percent');

        if (!progressContainer) {
            console.warn('[B站下载] 进度条容器不存在');
            return;
        }

        // 更新进度条
        if (progressBar) {
            progressBar.style.width = `${data.progress}%`;
        }

        // 更新文本
        if (progressText) {
            progressText.textContent = data.message || '';
        }

        if (progressPercent) {
            progressPercent.textContent = `${data.progress}%`;
        }

        console.log(`[B站下载] 进度已更新: ${data.progress}%`);
    });

    // 房间设置更新
    socket.on('settings-updated', ({ settings, updatedBy }) => {
        roomSettings = settings;
        showToast(`${updatedBy} 更新了房间设置`);
        updatePlayerControls(); // 更新权限控制 UI
        // 如果设置模态框打开，更新开关状态
        updateSettingsUI();
    });

    // 昵称修改
    socket.on('nickname-changed', ({ userId, oldName, newName, userList }) => {
        if (userId === socket.id) {
            userName = newName;
            sessionStorage.setItem('userName', newName);
        }
        updateUserList(userList);
        showNotification(`${oldName} 改名为 ${newName}`);
    });

    // 房主转让
    socket.on('host-transferred', ({ oldHostId, newHostId, userList }) => {
        if (newHostId === socket.id) {
            isHost = true;
            showToast('你已成为房主', 'success');
        } else if (oldHostId === socket.id) {
            isHost = false;
            showToast('房主已转让', 'info');
        }
        updateHostUI();
        updateUserList(userList);
    });

    // 权限被拒绝
    socket.on('permission-denied', ({ action, message }) => {
        showToast(message || '权限不足', 'error');
    });
}

function joinRoom() {
    showConnectionOverlay(true, '正在加入放映室...');

    // 发送 userId 以便后端识别用户身份
    const userId = getOrCreateUserId();

    socket.emit('join-room', { roomId, userName, userId }, (response) => {
        if (response.success) {
            showConnectionOverlay(false);
            updateSyncStatus('', '已同步');

            console.log('[joinRoom] 完整响应:', response);
            console.log('[joinRoom] response.isHost:', response.isHost, typeof response.isHost);

            // 更新房主状态和房间设置
            isHost = response.isHost;
            console.log('[joinRoom] 设置后的 isHost:', isHost);
            if (response.settings) {
                roomSettings = response.settings;
            }

            // 更新 UI 显示
            updateHostUI();
            updatePlayerControls(); // 初始化权限控制
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
        controls: false, // 禁用默认控件
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
        userActions: {
            doubleClick: false // 禁用双击全屏，防止冲突
        }
    });

    // 初始化自定义控件和弹幕系统
    player.ready(() => {
        initCustomControls();
        initDanmakuSystem();
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

function loadVideo(url, mseDataOrStartTime = null, autoPlay = false) {
    if (!player || !url) return;

    // 兼容旧的调用方式 loadVideo(url, startTime, autoPlay)
    let mseData = null;
    let startTime = 0;

    if (typeof mseDataOrStartTime === 'number') {
        startTime = mseDataOrStartTime;
    } else if (mseDataOrStartTime && typeof mseDataOrStartTime === 'object') {
        mseData = mseDataOrStartTime;
    }

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
        '.ts': 'video/mp2t',
        '.m4s': 'video/mp4'
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

    // 清除旧的 MSE 资源
    if (window.currentMseAudio) {
        window.currentMseAudio.pause();
        window.currentMseAudio.src = '';
        window.currentMseAudio = null;
    }

    // 先重置播放器
    player.reset();

    // MSE 模式：分离的视频和音频
    if (mseData && mseData.videoUrl && mseData.audioUrl) {
        console.log('使用 MSE 模式播放分离的音视频');

        // 创建隐藏的音频元素
        const audioElement = document.createElement('audio');
        audioElement.src = mseData.audioUrl;
        audioElement.preload = 'auto';
        window.currentMseAudio = audioElement;

        // 设置视频源
        player.src({
            src: mseData.videoUrl,
            type: 'video/mp4'
        });

        player.load();

        // 同步音频与视频
        const syncAudioWithVideo = () => {
            if (!window.currentMseAudio) return;

            // 同步时间
            if (Math.abs(window.currentMseAudio.currentTime - player.currentTime()) > 0.3) {
                window.currentMseAudio.currentTime = player.currentTime();
            }
        };

        player.on('play', () => {
            if (window.currentMseAudio) {
                window.currentMseAudio.currentTime = player.currentTime();
                window.currentMseAudio.play().catch(e => console.log('音频播放失败:', e));
            }
        });

        player.on('pause', () => {
            if (window.currentMseAudio) {
                window.currentMseAudio.pause();
            }
        });

        player.on('seeked', () => {
            if (window.currentMseAudio) {
                window.currentMseAudio.currentTime = player.currentTime();
            }
        });

        player.on('ratechange', () => {
            if (window.currentMseAudio) {
                window.currentMseAudio.playbackRate = player.playbackRate();
            }
        });

        // 定期同步
        player.on('timeupdate', syncAudioWithVideo);

        player.one('loadedmetadata', () => {
            console.log('MSE 视频元数据已加载');

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

        player.one('error', (e) => {
            console.error('MSE 视频加载错误:', player.error());
            showToast('视频加载失败', 'error');
            isSyncing = false;
        });

        // HLS 处理 (使用 hls.js 库)
    } else if (type === 'application/x-mpegURL' && typeof Hls !== 'undefined' && Hls.isSupported()) {
        console.log('使用 hls.js 加载 HLS 流');

        const videoElement = player.tech({ IWillNotUseThisInPlugins: true }).el();
        const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false
        });

        // Store reference for audio track selector
        currentHls = hls;

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

    // 发送聊天消息 - 同时显示为弹幕
    document.getElementById('chat-form').addEventListener('submit', (e) => {
        e.preventDefault();

        const input = document.getElementById('chat-input');
        const text = input.value.trim();

        if (!text) return;

        socket.emit('chat-message', { text });

        // 同时显示为弹幕（如果弹幕系统已初始化）
        if (danmakuManager && player) {
            danmakuManager.shoot(text, '#FFD700', true); // 金色标识聊天来源
        }

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

    userList.innerHTML = users.map(user => {
        const isCurrentUser = socket && user.id === socket.id;
        return `
        <li class="user-item">
            <div class="user-avatar">${getInitial(user.name)}</div>
            <span class="user-name">${escapeHtml(user.name)}</span>
            ${user.isHost ? '<span class="host-badge" title="房主"><i class="fa-solid fa-crown"></i></span>' : ''}
            ${isCurrentUser ? '<button class="edit-nickname-btn" onclick="showNicknameModal()" title="修改昵称"><i class="fa-solid fa-pen"></i></button>' : ''}
        </li>
        `;
    }).join('');
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
      <span class="message-time">${formatMessageTime(message.timestamp)}</span>
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
// 弹幕功能 - 已移至文件末尾的 Bilibili-Style Player 部分
// ==========================================

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
// 权限管理与用户功能
// ==========================================

// 更新房主 UI
function updateHostUI() {
    const hostIndicator = document.getElementById('host-indicator');
    const settingsBtn = document.getElementById('settings-btn');

    console.log('[updateHostUI] isHost:', isHost, 'hostIndicator:', hostIndicator, 'settingsBtn:', settingsBtn);

    if (!hostIndicator || !settingsBtn) {
        console.warn('[updateHostUI] 元素未找到');
        return;
    }

    if (isHost) {
        hostIndicator.style.display = 'flex';
        settingsBtn.style.display = 'flex';
        console.log('[updateHostUI] 显示房主 UI');
    } else {
        hostIndicator.style.display = 'none';
        settingsBtn.style.display = 'none';
        console.log('[updateHostUI] 隐藏房主 UI');
    }

    updatePlayerControls(); // 确保同时更新播放器控制权限
}

// 更新设置 UI
function updateSettingsUI() {
    document.getElementById('allow-video-switch').checked = roomSettings.allowAllChangeVideo;
    document.getElementById('allow-subtitle-switch').checked = roomSettings.allowAllChangeSubtitle;
    document.getElementById('allow-control-switch').checked = roomSettings.allowAllControl;
}

// 复制邀请链接
function copyInviteLink() {
    const inviteUrl = `${window.location.origin}/room.html?id=${roomId}`;
    navigator.clipboard.writeText(inviteUrl).then(() => {
        showToast('邀请链接已复制', 'success');
    }).catch(() => {
        // 降级方案
        const input = document.createElement('input');
        input.value = inviteUrl;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        showToast('邀请链接已复制', 'success');
    });
}

// 显示设置模态框
function showSettingsModal() {
    const modal = document.getElementById('settings-modal');
    updateSettingsUI();
    modal.classList.add('show');
}

// 隐藏设置模态框
function hideSettingsModal() {
    const modal = document.getElementById('settings-modal');
    modal.classList.remove('show');
}

// 保存房间设置
function saveRoomSettings() {
    const settings = {
        allowAllChangeVideo: document.getElementById('allow-video-switch').checked,
        allowAllChangeSubtitle: document.getElementById('allow-subtitle-switch').checked,
        allowAllControl: document.getElementById('allow-control-switch').checked
    };

    socket.emit('update-settings', { settings }, (response) => {
        if (response && response.success) {
            roomSettings = response.settings;
            hideSettingsModal();
            showToast('设置已保存', 'success');
        } else {
            showToast(response?.error || '保存设置失败', 'error');
        }
    });
}

// 显示昵称修改模态框
function showNicknameModal() {
    const modal = document.getElementById('nickname-modal');
    const input = document.getElementById('new-nickname-input');
    input.value = userName;
    modal.classList.add('show');
    setTimeout(() => input.focus(), 100);
}

// 隐藏昵称修改模态框
function hideNicknameModal() {
    const modal = document.getElementById('nickname-modal');
    modal.classList.remove('show');
}

// 保存昵称
function saveNickname() {
    const newName = document.getElementById('new-nickname-input').value.trim();

    if (!newName) {
        showToast('昵称不能为空', 'error');
        return;
    }

    if (newName === userName) {
        hideNicknameModal();
        return;
    }

    socket.emit('change-nickname', { newName }, (response) => {
        if (response && response.success) {
            hideNicknameModal();
            showToast('昵称已修改', 'success');
        } else {
            showToast(response?.error || '修改昵称失败', 'error');
        }
    });
}

// 初始化权限相关事件监听
function initPermissionListeners() {
    // 邀请按钮
    const inviteBtn = document.getElementById('invite-btn');
    if (inviteBtn) {
        inviteBtn.addEventListener('click', copyInviteLink);
    }

    // 设置按钮
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', showSettingsModal);
    }

    // 设置模态框
    const settingsClose = document.getElementById('settings-close');
    const saveSettingsBtn = document.getElementById('save-settings-btn');
    const settingsModal = document.getElementById('settings-modal');

    if (settingsClose) {
        settingsClose.addEventListener('click', hideSettingsModal);
    }
    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', saveRoomSettings);
    }
    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) hideSettingsModal();
        });
    }

    // 昵称模态框
    const nicknameClose = document.getElementById('nickname-close');
    const saveNicknameBtn = document.getElementById('save-nickname-btn');
    const cancelNicknameBtn = document.getElementById('cancel-nickname-btn');
    const nicknameModal = document.getElementById('nickname-modal');
    const nicknameInput = document.getElementById('new-nickname-input');

    if (nicknameClose) {
        nicknameClose.addEventListener('click', hideNicknameModal);
    }
    if (saveNicknameBtn) {
        saveNicknameBtn.addEventListener('click', saveNickname);
    }
    if (cancelNicknameBtn) {
        cancelNicknameBtn.addEventListener('click', hideNicknameModal);
    }
    if (nicknameModal) {
        nicknameModal.addEventListener('click', (e) => {
            if (e.target === nicknameModal) hideNicknameModal();
        });
    }
    if (nicknameInput) {
        nicknameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') saveNickname();
        });
    }
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

// ==========================================
// 📺 Bilibili-Style Player & Danmaku Logic
// ==========================================

class DanmakuManager {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.tracks = []; // 轨道占用状态
        this.trackHeight = 30; // 轨道高度
        this.duration = 10000; // 弹幕通过屏幕时间 (ms)
    }

    // 发送弹幕
    shoot(text, color = '#ffffff', isSelf = false) {
        const item = document.createElement('div');
        item.className = 'danmaku-item';
        item.textContent = text;
        item.style.color = color;
        if (isSelf) {
            item.style.border = '1px solid rgba(255,255,255,0.5)';
            item.style.zIndex = 100;
        }

        this.container.appendChild(item);

        // 计算轨道
        const trackIndex = this.findAvailableTrack();
        const top = trackIndex * this.trackHeight;
        item.style.top = top + 'px';

        // 标记轨道占用 (简单逻辑：占用 1秒)
        this.tracks[trackIndex] = Date.now() + 1000;

        // 动画
        const startLeft = this.container.offsetWidth;
        const endLeft = -item.offsetWidth;

        item.style.transform = `translateX(${startLeft}px)`;

        // 强制重绘
        item.offsetHeight;

        item.style.transition = `transform ${this.duration}ms linear`;
        item.style.transform = `translateX(${endLeft}px)`;

        // 清理
        setTimeout(() => {
            item.remove();
        }, this.duration);
    }

    findAvailableTrack() {
        const now = Date.now();
        const maxTracks = Math.floor(this.container.offsetHeight / this.trackHeight);

        for (let i = 0; i < maxTracks; i++) {
            if (!this.tracks[i] || this.tracks[i] < now) {
                return i;
            }
        }
        return Math.floor(Math.random() * maxTracks); // 没轨道了随机挤一个
    }

    clear() {
        this.container.innerHTML = '';
        this.tracks = [];
    }
}

let danmakuManager;

function initDanmakuSystem() {
    danmakuManager = new DanmakuManager('danmaku-layer');
    const input = document.getElementById('danmaku-input');
    const sendBtn = document.getElementById('send-danmaku-btn');
    const toggleBtn = document.getElementById('danmaku-toggle-btn');
    const layer = document.getElementById('danmaku-layer');

    function send() {
        const text = input.value.trim();
        if (!text) return;

        // 本地显示弹幕
        danmakuManager.shoot(text, '#ffffff', true);

        // 发送给服务器（同时作为聊天消息）
        socket.emit('send-danmaku', {
            text: text,
            color: '#ffffff',
            time: player.currentTime()
        });

        // 同时发送到聊天
        socket.emit('chat-message', { text: text });

        input.value = '';
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') send();
    });

    // 弹幕开关
    let isDanmakuOn = true;
    toggleBtn.addEventListener('click', () => {
        isDanmakuOn = !isDanmakuOn;
        layer.style.display = isDanmakuOn ? 'block' : 'none';
        toggleBtn.classList.toggle('active', isDanmakuOn);
        toggleBtn.innerHTML = isDanmakuOn ? '<i class="fa-solid fa-comment-dots"></i>' : '<i class="fa-regular fa-comment-dots"></i>';
    });

    // 监听服务器弹幕
    socket.on('broadcast-danmaku', (data) => {
        if (data.userId !== socket.id) { // 自己的已经在本地显示了
            danmakuManager.shoot(data.text, data.color);
        }
    });
}

// 自定义控件逻辑
function initCustomControls() {
    const controls = document.getElementById('custom-controls');
    const playBtn = document.getElementById('play-pause-btn');
    const volumeBtn = document.getElementById('volume-btn');
    const volumeSlider = document.getElementById('volume-slider');
    const speedMenu = document.querySelector('.speed-menu');
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const progressContainer = document.getElementById('progress-container');
    const progressBarCurrent = document.getElementById('progress-current');
    const progressBarBuffered = document.getElementById('progress-buffered');
    const currentTimeEl = document.getElementById('current-time');
    const durationEl = document.getElementById('duration');
    const speedDisplay = document.getElementById('current-speed');

    controls.style.display = 'flex'; // 显示控件

    // 权限检查辅助函数
    function canControlPlayer() {
        return isHost || roomSettings.allowAllControl;
    }

    // Play/Pause
    function togglePlay() {
        if (!canControlPlayer()) {
            showToast('只有房主可以控制播放', 'error');
            return;
        }
        if (player.paused()) player.play();
        else player.pause();
    }

    playBtn.addEventListener('click', togglePlay);
    player.on('play', () => playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>');
    player.on('pause', () => playBtn.innerHTML = '<i class="fa-solid fa-play"></i>');

    // Progress Bar
    function updateProgress() {
        const percent = (player.currentTime() / player.duration()) * 100;
        progressBarCurrent.style.width = percent + '%';
        currentTimeEl.textContent = formatDuration(player.currentTime());
        durationEl.textContent = formatDuration(player.duration());

        const buffered = player.bufferedEnd();
        const bufferedPercent = (buffered / player.duration()) * 100;
        progressBarBuffered.style.width = bufferedPercent + '%';
    }

    player.on('timeupdate', updateProgress);
    player.on('progress', updateProgress); // buffer update

    progressContainer.addEventListener('click', (e) => {
        if (!canControlPlayer()) {
            showToast('只有房主可以控制播放进度', 'error');
            return;
        }
        const rect = progressContainer.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        player.currentTime(pos * player.duration());
    });

    // Volume
    volumeSlider.addEventListener('input', (e) => {
        player.volume(e.target.value);
    });

    player.on('volumechange', () => {
        const vol = player.volume();
        volumeSlider.value = vol;
        if (player.muted() || vol === 0) {
            volumeBtn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i>';
        } else if (vol < 0.5) {
            volumeBtn.innerHTML = '<i class="fa-solid fa-volume-low"></i>';
        } else {
            volumeBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
        }
    });

    volumeBtn.addEventListener('click', () => {
        player.muted(!player.muted());
    });

    // Speed
    document.querySelectorAll('.speed-option').forEach(opt => {
        opt.addEventListener('click', () => {
            if (!canControlPlayer()) {
                showToast('只有房主可以调整播放速度', 'error');
                return;
            }
            const speed = parseFloat(opt.dataset.speed);
            player.playbackRate(speed);
            speedDisplay.textContent = speed + 'x';
        });
    });

    // Fullscreen - 使用 video-wrapper 容器（包含自定义控件）
    const videoWrapper = document.getElementById('video-wrapper');
    fullscreenBtn.addEventListener('click', () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
            fullscreenBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
        } else {
            videoWrapper.requestFullscreen();
            fullscreenBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
        }
    });

    // 监听全屏变化事件
    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement) {
            fullscreenBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
            // 启动全屏自动隐藏逻辑
            startFullscreenAutoHide();
        } else {
            fullscreenBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
            // 退出全屏时清理
            stopFullscreenAutoHide();
        }
    });

    // 全屏自动隐藏逻辑
    let hideTimer = null;
    let isControlsVisible = true;

    function showControls() {
        controls.style.opacity = '1';
        videoWrapper.style.cursor = 'default';
        isControlsVisible = true;
    }

    function hideControls() {
        if (document.fullscreenElement) {
            controls.style.opacity = '0';
            videoWrapper.style.cursor = 'none';
            isControlsVisible = false;
        }
    }

    function resetHideTimer() {
        showControls();
        clearTimeout(hideTimer);
        if (document.fullscreenElement) {
            hideTimer = setTimeout(hideControls, 3000); // 3秒后隐藏
        }
    }

    function startFullscreenAutoHide() {
        videoWrapper.addEventListener('mousemove', resetHideTimer);
        videoWrapper.addEventListener('click', resetHideTimer);
        resetHideTimer();
    }

    function stopFullscreenAutoHide() {
        videoWrapper.removeEventListener('mousemove', resetHideTimer);
        videoWrapper.removeEventListener('click', resetHideTimer);
        clearTimeout(hideTimer);
        showControls();
    }

    // Audio Track Selector (HLS.js)
    initAudioTrackSelector();

    // Subtitle Selector
    initSubtitleSelector();
}

function formatDuration(seconds) {
    if (isNaN(seconds)) return '00:00';
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

// ==========================================
// 音轨选择器
// ==========================================

let currentHls = null; // Store HLS instance reference

function initAudioTrackSelector() {
    const audioSelector = document.getElementById('audio-selector');
    const audioMenu = document.getElementById('audio-menu');

    if (!audioSelector || !audioMenu) return;

    // Listen for HLS instance creation (set by video loading code)
    function updateAudioTracks() {
        if (!currentHls || !currentHls.audioTracks || currentHls.audioTracks.length <= 1) {
            audioSelector.style.display = 'none';
            return;
        }

        audioSelector.style.display = 'flex';
        audioMenu.innerHTML = '';

        currentHls.audioTracks.forEach((track, index) => {
            const item = document.createElement('div');
            item.className = 'menu-item' + (index === currentHls.audioTrack ? ' active' : '');
            item.textContent = track.name || `音轨 ${index + 1}`;
            item.dataset.index = index;

            item.addEventListener('click', () => {
                currentHls.audioTrack = index;
                audioMenu.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                showToast(`已切换到: ${track.name || '音轨 ' + (index + 1)}`, 'success');
            });

            audioMenu.appendChild(item);
        });

        console.log('[AudioSelector] 已更新音轨列表，共', currentHls.audioTracks.length, '个音轨');
    }

    // Check periodically for HLS instance
    const checkInterval = setInterval(() => {
        if (currentHls) {
            updateAudioTracks();
            currentHls.on(Hls.Events.AUDIO_TRACKS_UPDATED, updateAudioTracks);
            clearInterval(checkInterval);
        }
    }, 1000);

    // Clear after 30 seconds if no HLS
    setTimeout(() => clearInterval(checkInterval), 30000);
}

// ==========================================
// 字幕选择器
// ==========================================

function initSubtitleSelector() {
    const subtitleSelector = document.getElementById('subtitle-selector');
    const subtitleMenu = document.getElementById('subtitle-menu');

    if (!subtitleSelector || !subtitleMenu || !player) return;

    function updateSubtitleMenu() {
        const textTracks = player.textTracks();
        subtitleMenu.innerHTML = '';

        // Add "Off" option
        const offItem = document.createElement('div');
        offItem.className = 'menu-item active';
        offItem.textContent = '关闭字幕';
        offItem.dataset.mode = 'off';
        offItem.addEventListener('click', () => {
            for (let i = 0; i < textTracks.length; i++) {
                textTracks[i].mode = 'disabled';
            }
            subtitleMenu.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
            offItem.classList.add('active');
            showToast('字幕已关闭', 'success');
        });
        subtitleMenu.appendChild(offItem);

        // Add subtitle tracks
        for (let i = 0; i < textTracks.length; i++) {
            const track = textTracks[i];
            if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;

            const item = document.createElement('div');
            item.className = 'menu-item' + (track.mode === 'showing' ? ' active' : '');
            item.textContent = track.label || `字幕 ${i + 1}`;
            item.dataset.index = i;

            item.addEventListener('click', () => {
                // Disable all tracks first
                for (let j = 0; j < textTracks.length; j++) {
                    textTracks[j].mode = 'disabled';
                }
                // Enable selected track
                track.mode = 'showing';
                subtitleMenu.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                showToast(`已启用: ${track.label || '字幕 ' + (i + 1)}`, 'success');
            });

            subtitleMenu.appendChild(item);

            // Update active state if track is showing
            if (track.mode === 'showing') {
                offItem.classList.remove('active');
                item.classList.add('active');
            }
        }
    }

    // Initial update
    updateSubtitleMenu();

    // Listen for track changes
    player.textTracks().addEventListener('addtrack', updateSubtitleMenu);
    player.textTracks().addEventListener('removetrack', updateSubtitleMenu);
}

// ==========================================
// B 站视频解析功能
// ==========================================

let bilibiliVideoInfo = null;    // 当前解析的视频信息
let bilibiliPlayUrl = null;      // 当前播放地址信息
let qrcodePollingTimer = null;   // 二维码轮询定时器

/**
 * 初始化 B 站功能
 */
function initBilibiliFeatures() {
    const parseBilibiliBtn = document.getElementById('parse-bilibili-btn');
    const bilibiliLoginBtn = document.getElementById('bilibili-login-btn');
    const bilibiliUrlInput = document.getElementById('bilibili-url-input');

    // 解析 B 站视频
    parseBilibiliBtn?.addEventListener('click', parseBilibiliVideo);
    bilibiliUrlInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') parseBilibiliVideo();
    });

    // 登录 B 站
    bilibiliLoginBtn?.addEventListener('click', openBilibiliLoginModal);

    // 扫码弹窗关闭
    document.getElementById('bilibili-qrcode-close')?.addEventListener('click', closeBilibiliLoginModal);

    // 视频弹窗关闭
    document.getElementById('bilibili-video-close')?.addEventListener('click', closeBilibiliVideoModal);

    // 播放按钮
    document.getElementById('bilibili-play-btn')?.addEventListener('click', playBilibiliVideo);

    // 分P 选择变化时重新获取清晰度
    document.getElementById('bilibili-page-select')?.addEventListener('change', onPageSelectChange);

    // 检查登录状态
    checkBilibiliLoginStatus();
}

/**
 * 从输入中提取 BV 号
 */
function extractBVID(input) {
    if (!input) return null;
    const match = input.match(/BV[a-zA-Z0-9]{10}/i);
    return match ? match[0] : null;
}

/**
 * 解析 B 站视频
 */
async function parseBilibiliVideo() {
    const input = document.getElementById('bilibili-url-input').value.trim();
    const bvid = extractBVID(input);

    if (!bvid) {
        showToast('请输入有效的 B 站视频链接或 BV 号', 'error');
        return;
    }

    const parseBtn = document.getElementById('parse-bilibili-btn');
    parseBtn.disabled = true;
    parseBtn.querySelector('span').textContent = '解析中...';

    try {
        const response = await fetch(`/api/bilibili/video/${bvid}?roomId=${roomId}`);
        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error || '解析失败');
        }

        bilibiliVideoInfo = result.data;
        showBilibiliVideoModal();

    } catch (err) {
        showToast(`解析失败: ${err.message}`, 'error');
    } finally {
        parseBtn.disabled = false;
        parseBtn.querySelector('span').textContent = '解析B站';
    }
}

/**
 * 显示视频信息弹窗
 */
function showBilibiliVideoModal() {
    if (!bilibiliVideoInfo) return;

    const modal = document.getElementById('bilibili-video-modal');
    const info = bilibiliVideoInfo;

    // 填充视频信息 (添加 referrerPolicy 解决防盗链)
    const coverImg = document.getElementById('bilibili-cover');
    coverImg.referrerPolicy = 'no-referrer';
    coverImg.src = info.pic.replace('http:', 'https:');
    document.getElementById('bilibili-title').textContent = info.title;
    document.getElementById('bilibili-author').textContent = `UP主: ${info.owner.name}`;
    document.getElementById('bilibili-stats').innerHTML = `
        <span><i class="fa-solid fa-play"></i> ${formatNumber(info.stat.view)}</span>
        <span><i class="fa-solid fa-comment"></i> ${formatNumber(info.stat.danmaku)}</span>
        <span><i class="fa-solid fa-thumbs-up"></i> ${formatNumber(info.stat.like)}</span>
    `;

    // 填充分P列表
    const pageSelect = document.getElementById('bilibili-page-select');
    pageSelect.innerHTML = '';
    info.pages.forEach(p => {
        const option = document.createElement('option');
        option.value = p.cid;
        option.textContent = info.pages.length > 1 ? `P${p.page}: ${p.part}` : info.title;
        pageSelect.appendChild(option);
    });

    // 获取清晰度列表
    fetchQualityList(info.bvid, info.cid);

    modal.classList.add('show');
}

/**
 * 格式化数字
 */
function formatNumber(num) {
    if (num >= 10000) {
        return (num / 10000).toFixed(1) + '万';
    }
    return num.toString();
}

/**
 * 关闭视频信息弹窗
 */
function closeBilibiliVideoModal() {
    document.getElementById('bilibili-video-modal').classList.remove('show');
}

/**
 * 分P选择变化时重新获取清晰度
 */
function onPageSelectChange() {
    const cid = document.getElementById('bilibili-page-select').value;
    if (bilibiliVideoInfo && cid) {
        fetchQualityList(bilibiliVideoInfo.bvid, cid);
    }
}

/**
 * 获取清晰度列表
 */
async function fetchQualityList(bvid, cid) {
    const qualitySelect = document.getElementById('bilibili-quality-select');
    qualitySelect.innerHTML = '<option value="">加载中...</option>';

    try {
        const response = await fetch(`/api/bilibili/playurl?bvid=${bvid}&cid=${cid}&roomId=${roomId}`);
        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error);
        }

        bilibiliPlayUrl = result.data;

        // 填充清晰度选项
        qualitySelect.innerHTML = '';
        result.data.qualities.forEach(q => {
            const option = document.createElement('option');
            option.value = q.qn;
            option.textContent = q.description;
            qualitySelect.appendChild(option);
        });

        // 默认选中当前清晰度
        qualitySelect.value = result.data.quality;

    } catch (err) {
        qualitySelect.innerHTML = '<option value="">获取失败</option>';
        console.error('获取清晰度失败:', err);
    }
}

/**
 * 播放 B 站视频
 */
async function playBilibiliVideo() {
    if (!bilibiliVideoInfo) {
        showToast('请先解析视频', 'error');
        return;
    }

    const playBtn = document.getElementById('bilibili-play-btn');
    const progressContainer = document.getElementById('bilibili-progress-container');
    const progressBar = document.getElementById('bilibili-progress-bar');
    const progressText = document.getElementById('bilibili-progress-text');
    const progressPercent = document.getElementById('bilibili-progress-percent');
    const qn = document.getElementById('bilibili-quality-select').value;
    const cid = document.getElementById('bilibili-page-select').value;

    playBtn.disabled = true;
    playBtn.style.display = 'none';

    // 显示进度条
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressText.textContent = '准备下载...';
    progressPercent.textContent = '0%';

    try {
        // 调用后端下载 API
        const response = await fetch('/api/bilibili/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bvid: bilibiliVideoInfo.bvid,
                cid: cid,
                qn: qn || 80,
                roomId: roomId
            })
        });

        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error || '下载失败');
        }

        // 隐藏进度条
        progressContainer.style.display = 'none';

        // 关闭弹窗
        closeBilibiliVideoModal();

        // MSE 播放：传递分离的音视频 URL
        if (result.data.type === 'mse') {
            // 通知房间使用 MSE 播放
            socket.emit('change-video', {
                url: result.data.videoUrl,
                mseData: {
                    videoUrl: result.data.videoUrl,
                    audioUrl: result.data.audioUrl,
                    codecs: result.data.codecs
                }
            });
        } else {
            // 普通视频播放
            socket.emit('change-video', { url: result.data.url });
        }

        showToast(`正在加载: ${bilibiliVideoInfo.title}`, 'success');

    } catch (err) {
        showToast(`播放失败: ${err.message}`, 'error');
        // 出错时隐藏进度条
        progressContainer.style.display = 'none';
    } finally {
        playBtn.disabled = false;
        playBtn.style.display = 'flex';
    }
}

/**
 * 打开 B 站登录弹窗
 */
async function openBilibiliLoginModal() {
    const modal = document.getElementById('bilibili-qrcode-modal');
    const container = document.getElementById('qrcode-container');
    const status = document.getElementById('qrcode-status');

    modal.classList.add('show');
    container.innerHTML = '<div class="qrcode-loading"><div class="loading-spinner"></div><p>正在生成二维码...</p></div>';
    status.textContent = '';
    status.className = 'qrcode-status';

    try {
        const response = await fetch('/api/bilibili/qrcode');
        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error);
        }

        // 使用后端生成的 base64 二维码图片
        container.innerHTML = `<img src="${result.qrcode_image}" alt="登录二维码">`;

        // 开始轮询
        startQRCodePolling(result.qrcode_key);

    } catch (err) {
        container.innerHTML = `<div class="qrcode-loading"><p style="color: #ef4444;">生成二维码失败</p></div>`;
        status.textContent = err.message;
        status.className = 'qrcode-status error';
    }
}

/**
 * 关闭登录弹窗
 */
function closeBilibiliLoginModal() {
    const modal = document.getElementById('bilibili-qrcode-modal');
    modal.classList.remove('show');

    // 停止轮询
    if (qrcodePollingTimer) {
        clearInterval(qrcodePollingTimer);
        qrcodePollingTimer = null;
    }
}

/**
 * 开始轮询二维码状态
 */
function startQRCodePolling(qrcodeKey) {
    const status = document.getElementById('qrcode-status');
    let pollCount = 0;
    const maxPolls = 90; // 最多轮询 90 次 (约 180 秒)

    qrcodePollingTimer = setInterval(async () => {
        pollCount++;

        if (pollCount > maxPolls) {
            clearInterval(qrcodePollingTimer);
            status.textContent = '二维码已过期，请重新生成';
            status.className = 'qrcode-status error';
            return;
        }

        try {
            const response = await fetch(`/api/bilibili/qrcode/poll?qrcode_key=${qrcodeKey}&roomId=${roomId}`);
            const result = await response.json();

            switch (result.code) {
                case 0: // 登录成功
                    clearInterval(qrcodePollingTimer);
                    status.textContent = '登录成功！';
                    status.className = 'qrcode-status success';
                    setTimeout(() => {
                        closeBilibiliLoginModal();
                        checkBilibiliLoginStatus();
                        showToast('B 站登录成功', 'success');
                    }, 1000);
                    break;

                case 86090: // 已扫码未确认
                    status.textContent = '已扫码，请在手机上确认';
                    break;

                case 86038: // 已过期
                    clearInterval(qrcodePollingTimer);
                    status.textContent = '二维码已过期，请重新生成';
                    status.className = 'qrcode-status error';
                    break;

                case 86101: // 未扫码
                default:
                    status.textContent = '等待扫码...';
                    break;
            }
        } catch (err) {
            console.error('轮询失败:', err);
        }
    }, 2000);
}

/**
 * 检查 B 站登录状态
 */
async function checkBilibiliLoginStatus() {
    try {
        const response = await fetch(`/api/bilibili/login-status?roomId=${roomId}`);
        const result = await response.json();

        const loginBtn = document.getElementById('bilibili-login-btn');
        const loginText = document.getElementById('bilibili-login-text');

        if (result.isLogin) {
            loginBtn.classList.add('logged-in');
            loginText.textContent = result.username || '已登录';
            loginBtn.title = `已登录: ${result.username}`;
        } else {
            loginBtn.classList.remove('logged-in');
            loginText.textContent = '登录B站';
            loginBtn.title = '登录 B 站账号获取高清视频';
        }
    } catch (err) {
        console.error('检查登录状态失败:', err);
    }
}

// 在 startRoom 中初始化 B 站功能
const originalStartRoom = startRoom;
startRoom = function () {
    originalStartRoom();
    initBilibiliFeatures();
};
