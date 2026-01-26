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

// 屏幕共享相关变量
let screenStream = null;           // 本地屏幕流
let peerConnections = new Map();   // peerId -> RTCPeerConnection
let isScreenSharing = false;       // 是否正在共享
let currentSharer = null;          // 当前共享者信息 { id, name }
let connectionRetryCount = 0;      // P2P 连接重试次数
const MAX_RETRY_COUNT = 3;         // 最大重试次数

// P2P 视频片段共享
let p2pLoader = null;              // P2P 加载器实例
let p2pEnabled = true;             // P2P 开关

// P2P 连接质量监控
let statsInterval = null;          // 统计定时器
let lastBytesReceived = 0;         // 上次收到的字节数
let lastStatsTime = 0;             // 上次统计时间

// 自适应码率配置
const BITRATE_LEVELS = [
    { bitrate: 500, label: '极低' },
    { bitrate: 1000, label: '低' },
    { bitrate: 2500, label: '中' },
    { bitrate: 5000, label: '高' },
    { bitrate: 8000, label: '超高' }
];
let currentBitrateLevel = 3;       // 当前码率级别索引 (默认高)
let consecutiveGoodStats = 0;      // 连续良好统计次数
let consecutiveBadStats = 0;       // 连续差统计次数

const rtcConfig = {
    iceServers: [
        // 国内可访问的 STUN 服务器
        { urls: 'stun:stun.miwifi.com:3478' },      // 小米
        { urls: 'stun:stun.qq.com:3478' },          // 腾讯
        // 国际 STUN 服务器（备用）
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.stunprotocol.org:3478' }
    ],
    iceCandidatePoolSize: 10,       // 预先收集 ICE 候选，加速连接
    bundlePolicy: 'max-bundle',     // 优化：合并媒体流
    rtcpMuxPolicy: 'require'        // 优化：RTCP 复用
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
        const passwordGroup = document.getElementById('join-password-group');
        const passwordInput = document.getElementById('join-password-input');
        const joinBtn = document.getElementById('join-btn');
        const errorEl = document.getElementById('join-error');
        const descEl = document.getElementById('join-modal-desc');

        // 检查房间是否需要密码
        fetch(`/api/room/${roomId}`)
            .then(res => res.json())
            .then(data => {
                if (!data.exists) {
                    alert('房间不存在');
                    window.location.href = '/';
                    return;
                }

                // 如果房间有密码，显示密码输入框
                if (data.hasPassword) {
                    passwordGroup.style.display = 'block';
                    descEl.textContent = `加入「${data.name || '放映室'}」需要密码`;
                }

                modal.classList.add('show');
            })
            .catch(() => {
                // 网络错误，仍然显示弹窗但不显示密码框
                modal.classList.add('show');
            });

        const joinAction = () => {
            const name = nameInput.value.trim();
            const password = passwordInput ? passwordInput.value : '';

            if (!name) {
                errorEl.textContent = '请输入昵称';
                return;
            }

            // 如果需要密码但没输入
            if (passwordGroup.style.display !== 'none' && !password) {
                errorEl.textContent = '请输入房间密码';
                return;
            }

            userName = name;
            sessionStorage.setItem('userName', name);
            sessionStorage.setItem('roomId', roomId);
            if (password) {
                sessionStorage.setItem('roomPassword', password);
            }
            modal.classList.remove('show');
            startRoom();
        };

        joinBtn.addEventListener('click', joinAction);
        nameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                if (passwordGroup.style.display !== 'none') {
                    passwordInput.focus();
                } else {
                    joinAction();
                }
            }
        });
        passwordInput?.addEventListener('keypress', (e) => {
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

    // 同步播放速度
    socket.on('sync-speed', ({ playbackRate, triggeredBy }) => {
        if (!player) return;

        isSyncing = true;
        updateSyncStatus('syncing', '同步中...');

        player.playbackRate(playbackRate);
        // 同步音频播放速度 (MSE 模式)
        if (window.currentMseAudio) {
            window.currentMseAudio.playbackRate = playbackRate;
        }
        // 更新速度显示
        const speedDisplay = document.getElementById('current-speed');
        if (speedDisplay) {
            speedDisplay.textContent = playbackRate + 'x';
        }

        setTimeout(() => {
            isSyncing = false;
            updateSyncStatus('', '已同步');
        }, 500);

        showNotification(`${triggeredBy} 调整了播放速度为 ${playbackRate}x`);
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
    // 获取密码（如果有）
    const password = sessionStorage.getItem('roomPassword') || null;
    // 使用后清除密码
    sessionStorage.removeItem('roomPassword');

    socket.emit('join-room', { roomId, userName, userId, password }, (response) => {
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
                loadVideo(response.videoUrl, response.mseData);

                // 加载字幕
                if (response.subtitleUrl) {
                    // 延迟加载字幕确保播放器已就绪
                    setTimeout(() => {
                        setSubtitle(response.subtitleUrl);
                    }, 500);
                }

                // 同步到当前进度和播放速度
                setTimeout(() => {
                    if (player && response.videoState) {
                        player.currentTime(response.videoState.currentTime);
                        // 同步播放速度
                        if (response.videoState.playbackRate && response.videoState.playbackRate !== 1) {
                            player.playbackRate(response.videoState.playbackRate);
                            if (window.currentMseAudio) {
                                window.currentMseAudio.playbackRate = response.videoState.playbackRate;
                            }
                            const speedDisplay = document.getElementById('current-speed');
                            if (speedDisplay) {
                                speedDisplay.textContent = response.videoState.playbackRate + 'x';
                            }
                        }
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

            // 同步屏幕共享状态 - 如果有人正在共享
            if (response.screenShareState && response.screenShareState.isSharing) {
                console.log('[屏幕共享] 加入时发现有人正在共享:', response.screenShareState.sharerName);
                currentSharer = {
                    id: response.screenShareState.sharerId,
                    name: response.screenShareState.sharerName
                };
                showNotification(`${response.screenShareState.sharerName} 正在共享屏幕`);
                // 延迟发送请求，确保事件监听器已初始化
                setTimeout(() => {
                    socket.emit('screen-share-request');
                    console.log('[屏幕共享] 加入时发送 screen-share-request');
                }, 500);
            }

            // 初始化 P2P 视频片段共享
            if (typeof P2PLoader !== 'undefined' && p2pEnabled) {
                p2pLoader = new P2PLoader(socket, roomId, rtcConfig);
                p2pLoader.join();
                console.log('[P2P] 视频片段共享已启动');
            }

            showToast(`已加入放映室 ${roomId}`, 'success');
        } else {
            showConnectionOverlay(false);

            // 如果需要密码，重定向回首页让用户输入密码
            if (response.needPassword) {
                alert(`加入房间失败: ${response.error}`);
                // 保存信息以便首页自动弹出密码框
                sessionStorage.setItem('pendingRoom', roomId);
                sessionStorage.setItem('pendingUserName', userName);
                window.location.href = '/';
            } else {
                alert(response.error || '加入房间失败');
                window.location.href = '/';
            }
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

/**
 * 创建 P2P 片段加载器（用于 HLS.js）
 * 优先从 P2P 网络获取片段，失败时回退到 HTTP
 */
function createP2PFragmentLoader(p2pLoader) {
    return class P2PFragmentLoader extends Hls.DefaultConfig.loader {
        constructor(config) {
            super(config);
            this.p2pLoader = p2pLoader;
        }

        load(context, config, callbacks) {
            const url = context.url;
            const isSegment = context.type === 'fragment';

            // 只对视频片段使用 P2P
            if (isSegment && this.p2pLoader && this.p2pLoader.enabled) {
                // 尝试从 P2P 获取
                this.p2pLoader.getSegment(url).then(data => {
                    if (data) {
                        // P2P 获取成功
                        console.log(`[P2P] 从 P2P 加载片段: ${url.substring(0, 60)}...`);
                        const response = {
                            url,
                            data
                        };
                        callbacks.onSuccess(response, { url }, context, null);
                    } else {
                        // P2P 失败，回退到 HTTP
                        this._loadViaHttp(context, config, callbacks);
                    }
                }).catch(() => {
                    // 出错时回退到 HTTP
                    this._loadViaHttp(context, config, callbacks);
                });
            } else {
                // 非片段请求（如 m3u8）直接用 HTTP
                this._loadViaHttp(context, config, callbacks);
            }
        }

        _loadViaHttp(context, config, callbacks) {
            // 包装原始回调，在成功时缓存到 P2P
            const originalOnSuccess = callbacks.onSuccess;
            callbacks.onSuccess = (response, stats, context, networkDetails) => {
                // 如果是片段，缓存到 P2P
                if (context.type === 'fragment' && this.p2pLoader && response.data) {
                    this.p2pLoader.addToCache(context.url, response.data);
                    this.p2pLoader.stats.httpDownloaded += response.data.byteLength || 0;
                }
                originalOnSuccess(response, stats, context, networkDetails);
            };

            // 调用父类的 HTTP 加载
            super.load(context, config, callbacks);
        }
    };
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
    // 对于代理 URL，提取原始 URL 进行类型检测
    let urlForTypeDetection = url;
    if (url.includes('/api/parser/proxy?url=')) {
        try {
            const proxyParams = new URLSearchParams(url.split('?')[1]);
            urlForTypeDetection = decodeURIComponent(proxyParams.get('url') || url);
        } catch (e) {
            console.log('解析代理 URL 失败:', e);
        }
    }

    const urlLower = urlForTypeDetection.toLowerCase();
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

        // 配置 HLS.js，集成 P2P 加载
        const hlsConfig = {
            enableWorker: true,
            lowLatencyMode: false
        };

        // 如果启用了 P2P，添加自定义片段加载器
        if (p2pLoader && p2pEnabled) {
            hlsConfig.fLoader = createP2PFragmentLoader(p2pLoader);
            console.log('[P2P] 已启用 HLS P2P 加载');
        }

        const hls = new Hls(hlsConfig);

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
            console.log('当前 URL:', url);
            console.log('是否已使用代理:', url.includes('/api/parser/proxy'));

            // 检查是否是 CORS 或网络错误，尝试使用代理
            if (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR && !url.includes('/api/parser/proxy')) {
                console.log('HLS 网络错误，尝试使用代理...');
                hls.destroy();

                // 使用代理 URL 重试
                const proxyUrl = `/api/parser/proxy?url=${encodeURIComponent(url)}`;
                console.log('代理 URL:', proxyUrl);
                showToast('尝试通过代理加载...', 'info');
                loadVideo(proxyUrl, startTime, autoPlay);
                return;
            }

            if (data.fatal) {
                showToast('视频加载失败，可能需要通过代理访问', 'error');
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
    uploadBtn.disabled = true;
    // uploadBtn.querySelector('span').textContent = '转换中...'; // 移除对 span 的依赖

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
            // uploadBtn.querySelector('span').textContent = originalText;
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
    // uploadBtn.querySelector('span:last-child').textContent = '上传中...';

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
        // uploadBtn.querySelector('span:last-child').textContent = '上传文件';
    });

    // 上传错误
    xhr.addEventListener('error', () => {
        showToast('网络错误，上传失败', 'error');
        uploadProgress.style.display = 'none';
        transcodeOverlay.style.display = 'none';
        uploadBtn.disabled = false;
        // uploadBtn.querySelector('span:last-child').textContent = '上传文件';
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

    userList.innerHTML = '';
    userCount.textContent = users.length;

    users.forEach(user => {
        const li = document.createElement('li');
        li.className = 'user-item';

        // 名字颜色：房主金色，自己绿色，其他人白色
        let nameClass = '';
        if (user.isHost) nameClass = 'is-host';
        if (user.id === socket.id) nameClass = 'is-self';

        // 屏幕共享标识
        let screenShareBadge = '';
        if (currentSharer && currentSharer.id === user.id) {
            screenShareBadge = `
                <div class="user-screen-share-status">
                    <span class="badge sharing">共享中</span>
                    ${user.id !== socket.id ? `<button onclick="joinScreenShare()" class="btn-xs btn-primary watch-btn" title="观看共享"><i class="fa-solid fa-eye"></i></button>` : ''}
                </div>
            `;
        }

        li.innerHTML = `
            <div class="user-avatar">${getInitial(user.name)}</div>
            <div class="user-info">
                <div class="user-name ${nameClass}">
                    ${user.name}
                    ${user.isHost ? '<span class="host-badge" title="房主"><i class="fa-solid fa-crown"></i></span>' : ''}
                </div>
                ${screenShareBadge}
            </div>
            ${user.id === socket.id ? '<button class="edit-nickname-btn" onclick="showNicknameModal()" title="修改昵称"><i class="fa-solid fa-pen"></i></button>' : ''}
        `;
        userList.appendChild(li);
    });
}

/**
 * 更新 P2P 状态显示
 */
function updateP2PStatus() {
    const statusEl = document.getElementById('p2p-status');
    if (!statusEl) return;

    const peersEl = statusEl.querySelector('.p2p-peers');

    if (p2pLoader && p2pEnabled) {
        const stats = p2pLoader.getStats();
        peersEl.textContent = stats.connectedPeers;

        if (stats.connectedPeers > 0) {
            statusEl.classList.add('active');
            statusEl.classList.remove('inactive');
            statusEl.title = `P2P 已连接 ${stats.connectedPeers} 个用户\n` +
                `P2P 下载: ${formatBytes(stats.p2pDownloaded)}\n` +
                `P2P 上传: ${formatBytes(stats.p2pUploaded)}\n` +
                `HTTP 下载: ${formatBytes(stats.httpDownloaded)}\n` +
                `P2P 占比: ${stats.p2pRatio}%`;
        } else {
            statusEl.classList.remove('active');
            statusEl.classList.add('inactive');
            statusEl.title = 'P2P 等待其他用户连接...';
        }
    } else {
        statusEl.classList.remove('active');
        statusEl.classList.add('inactive');
        peersEl.textContent = '-';
        statusEl.title = 'P2P 未启用';
    }
}

/**
 * 格式化字节数
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// 定时更新 P2P 状态
setInterval(updateP2PStatus, 2000);

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
    danmakuManager = new DanmakuManager('danmaku-container');
    const input = document.getElementById('danmaku-input');
    const sendBtn = document.getElementById('send-danmaku-btn');
    const toggleBtn = document.getElementById('danmaku-toggle-btn');
    const layer = document.getElementById('danmaku-container');

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
        // 同步音量到 MSE 音频元素 (B站视频)
        if (window.currentMseAudio) {
            window.currentMseAudio.volume = e.target.value;
        }
    });

    player.on('volumechange', () => {
        const vol = player.volume();
        const isMuted = player.muted();
        volumeSlider.value = vol;

        // 同步音量和静音状态到 MSE 音频元素 (B站视频)
        if (window.currentMseAudio) {
            window.currentMseAudio.volume = vol;
            window.currentMseAudio.muted = isMuted;
        }

        if (isMuted || vol === 0) {
            volumeBtn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i>';
        } else if (vol < 0.5) {
            volumeBtn.innerHTML = '<i class="fa-solid fa-volume-low"></i>';
        } else {
            volumeBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
        }
    });

    volumeBtn.addEventListener('click', () => {
        player.muted(!player.muted());
        // 同步静音状态到 MSE 音频元素 (B站视频)
        if (window.currentMseAudio) {
            window.currentMseAudio.muted = player.muted();
        }
    });

    // Speed
    // Toggle menu on click for better mobile/desktop experience
    const speedSelector = document.querySelector('.speed-selector');

    speedDisplay.addEventListener('click', (e) => {
        e.stopPropagation();
        speedMenu.classList.toggle('show');
    });

    document.querySelectorAll('.speed-option').forEach(opt => {
        opt.addEventListener('click', () => {
            if (!canControlPlayer()) {
                showToast('只有房主可以调整播放速度', 'error');
                return;
            }
            const speed = parseFloat(opt.dataset.speed);
            player.playbackRate(speed);
            // 同步音频播放速度 (MSE 模式)
            if (window.currentMseAudio) {
                window.currentMseAudio.playbackRate = speed;
            }
            speedDisplay.textContent = speed + 'x';

            // Close menu
            speedMenu.classList.remove('show');

            // 同步到其他客户端
            if (!isSyncing) {
                socket.emit('video-speed', { playbackRate: speed });
            }
        });
    });

    // Fullscreen - 使用 video-wrapper 容器（包含自定义控件）
    const videoWrapper = document.getElementById('video-wrapper');
    // Fullscreen Cross-browser support
    fullscreenBtn.addEventListener('click', () => {
        const videoElement = player.tech(true).el();

        // 1. Exit Fullscreen if active
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
            return;
        }

        // 2. Enter Fullscreen
        // Try standard/prefixed wrapper fullscreen first (Desktop/Android)
        if (videoWrapper.requestFullscreen) {
            videoWrapper.requestFullscreen();
        } else if (videoWrapper.webkitRequestFullscreen) {
            videoWrapper.webkitRequestFullscreen();
        }
        // 3. Fallback for iOS (Video Element Only)
        else if (videoElement.webkitEnterFullscreen) {
            videoElement.webkitEnterFullscreen();
            // iOS native player doesn't trigger standard fullscreenchange events consistently for the document
            // manually update icon here, though the native player takes over UI anyway.
            fullscreenBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
        } else {
            // Last resort: simple full viewport style (optional, maybe not needed if native supported)
            console.warn('Fullscreen API not supported');
        }
    });

    // Listen for iOS native fullscreen exit
    const videoElement = player.tech(true).el();
    videoElement.addEventListener('webkitendfullscreen', () => {
        fullscreenBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
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

    // Global click listener to close menus
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.speed-selector')) {
            const speedMenu = document.querySelector('.speed-menu');
            if (speedMenu) speedMenu.classList.remove('show');
        }
        if (!e.target.closest('.audio-track-selector') && !e.target.closest('#audio-selector')) {
            const audioMenu = document.getElementById('audio-menu');
            if (audioMenu) audioMenu.classList.remove('show');
        }
        if (!e.target.closest('.subtitle-selector') && !e.target.closest('#subtitle-selector')) {
            const subtitleMenu = document.getElementById('subtitle-menu');
            if (subtitleMenu) subtitleMenu.classList.remove('show');
        }
    });
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
                audioMenu.classList.remove('show'); // Close menu
            });

            audioMenu.appendChild(item);
        });

    }

    // Add toggle support
    const btn = audioSelector.querySelector('.control-btn');
    if (btn) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            audioMenu.classList.toggle('show');
        });
    }

    // Check periodically for HLS instance

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
            offItem.classList.add('active');
            showToast('字幕已关闭', 'success');
            subtitleMenu.classList.remove('show'); // Close menu
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
                item.classList.add('active');
                showToast(`已启用: ${track.label || '字幕 ' + (i + 1)}`, 'success');
                subtitleMenu.classList.remove('show'); // Close menu
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

    // Add toggle support
    const btn = subtitleSelector.querySelector('.control-btn');
    if (btn) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            subtitleMenu.classList.toggle('show');
        });
    }

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
            loginText.textContent = '登录';
            loginBtn.title = '登录 B 站账号获取高清视频';
        }
    } catch (err) {
        console.error('检查登录状态失败:', err);
    }
}

// Tab Switching Logic
function initTabListeners() {
    const tabs = document.querySelectorAll('.input-tab');
    const contents = document.querySelectorAll('.input-tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Remove active class from all
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));

            // Add active class to current
            tab.classList.add('active');
            const targetId = tab.dataset.target;
            const targetContent = document.getElementById(targetId);
            if (targetContent) {
                targetContent.classList.add('active');
            }
        });
    });
}

// Initialize everything when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initPermissionListeners();
    initCustomControls();
    initBilibiliFeatures();
    initVideoParser(); // Renamed from initParserFeatures to match existing function name
    initTabListeners(); // Add tab listeners
});

// 在 startRoom 中初始化 B 站功能
const originalStartRoom = startRoom;
startRoom = function () {
    originalStartRoom();
    // initBilibiliFeatures(); // Moved to DOMContentLoaded
    // initVideoParser();  // Moved to DOMContentLoaded
};

// ==========================================
// 通用视频解析功能 (yt-dlp)
// ==========================================

let pendingParseResult = null;  // 待加载的解析结果
let parserSupportedSites = [];  // 支持的网站列表

/**
 * 初始化视频解析功能
 */
function initVideoParser() {
    const parseBtn = document.getElementById('parse-video-btn');
    const urlInput = document.getElementById('parser-url-input');
    const helpBtn = document.getElementById('parser-help-btn');
    const rulesBtn = document.getElementById('parser-rules-btn');

    // 解析按钮点击
    parseBtn?.addEventListener('click', parseVideoUrl);

    // 回车触发解析
    urlInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') parseVideoUrl();
    });

    // 帮助按钮 - 显示支持的网站
    helpBtn?.addEventListener('click', showSupportedSites);

    // 规则管理按钮
    rulesBtn?.addEventListener('click', showRulesModal);

    // 预览弹窗事件
    document.getElementById('parser-modal-close')?.addEventListener('click', hideParserModal);
    document.getElementById('parser-cancel-btn')?.addEventListener('click', hideParserModal);
    document.getElementById('parser-confirm-btn')?.addEventListener('click', confirmLoadParsedVideo);

    // 支持网站弹窗事件
    document.getElementById('parser-sites-close')?.addEventListener('click', hideParserSitesModal);
    document.getElementById('parser-sites-ok-btn')?.addEventListener('click', hideParserSitesModal);

    // 规则管理弹窗事件
    initRulesModal();

    // 监听解析进度
    socket.on('parser-progress', handleParserProgress);

    // 预加载支持的网站列表
    loadSupportedSites();
}

/**
 * 加载支持的网站列表
 */
async function loadSupportedSites() {
    try {
        const res = await fetch('/api/parser/status');
        const data = await res.json();
        if (data.success) {
            parserSupportedSites = data.supportedSites || [];
            // 检查 yt-dlp 状态
            if (!data.parsers.ytdlp) {
                console.warn('[视频解析] yt-dlp 未安装');
            } else {
                console.log('[视频解析] yt-dlp 版本:', data.parsers.ytdlpVersion);
            }
        }
    } catch (err) {
        console.error('[视频解析] 获取支持列表失败:', err);
    }
}

/**
 * 解析视频 URL
 */
async function parseVideoUrl() {
    const urlInput = document.getElementById('parser-url-input');
    const url = urlInput?.value.trim();

    if (!url) {
        showToast('请输入视频网页链接', 'error');
        return;
    }

    // 检查是否是 B 站链接
    if (url.includes('bilibili.com') || url.includes('b23.tv')) {
        // 自动填充到 B 站输入框
        document.getElementById('bilibili-url-input').value = url;
        document.getElementById('parse-bilibili-btn').click();
        urlInput.value = '';
        return;
    }

    // 显示进度
    showParserProgress(true);
    updateParserProgress(5, '正在分析网页...');

    // 禁用按钮
    const parseBtn = document.getElementById('parse-video-btn');
    if (parseBtn) {
        parseBtn.disabled = true;
        parseBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 解析中';
    }

    try {
        // 获取视频信息
        const infoRes = await fetch('/api/parser/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        const infoData = await infoRes.json();

        if (!infoData.success) {
            if (infoData.redirect === 'bilibili') {
                // B站链接，重定向
                document.getElementById('bilibili-url-input').value = url;
                document.getElementById('parse-bilibili-btn').click();
                urlInput.value = '';
                showParserProgress(false);
                return;
            }
            throw new Error(infoData.error || '获取视频信息失败');
        }

        updateParserProgress(30, `找到: ${infoData.data.title?.slice(0, 30) || '未知'}...`);

        // 显示预览弹窗
        showParserPreview(infoData.data, url);

    } catch (err) {
        showToast(err.message || '解析失败', 'error');
        showParserProgress(false);
    } finally {
        // 恢复按钮
        if (parseBtn) {
            parseBtn.disabled = false;
            parseBtn.innerHTML = '<span>解析视频</span>';
        }
    }
}

/**
 * 显示解析预览弹窗
 */
function showParserPreview(info, url) {
    pendingParseResult = { info, url };

    const modal = document.getElementById('parser-preview-modal');
    const thumbnail = document.getElementById('parser-thumbnail');
    const title = document.getElementById('parser-title');
    const duration = document.getElementById('parser-duration');
    const uploader = document.getElementById('parser-uploader');
    const site = document.getElementById('parser-site');
    const qualitySelector = document.getElementById('parser-quality-selector');
    const qualitySelect = document.getElementById('parser-quality-select');

    // 填充信息
    if (info.thumbnail) {
        thumbnail.src = info.thumbnail;
        thumbnail.style.display = 'block';
    } else {
        thumbnail.style.display = 'none';
    }

    title.textContent = info.title || '未知标题';
    duration.querySelector('span').textContent = info.duration ? formatDurationSeconds(info.duration) : '未知';
    uploader.querySelector('span').textContent = info.uploader || '未知';
    site.querySelector('span').textContent = info.extractor || info.extractor_key || '未知';

    // 画质选择 - 如果是通用解析器返回的直接 URL，隐藏画质选择
    if (info.directUrl) {
        qualitySelector.style.display = 'none';
    } else {
        // 画质选择
        const videoFormats = (info.formats || []).filter(f =>
            f.hasVideo && f.resolution && f.ext
        );

        if (videoFormats.length > 1) {
            qualitySelector.style.display = 'block';
            qualitySelect.innerHTML = '<option value="best">自动 (最佳画质)</option>';

            // 按分辨率排序并去重
            const seen = new Set();
            videoFormats
                .sort((a, b) => (b.height || 0) - (a.height || 0))
                .forEach(f => {
                    const key = f.resolution;
                    if (!seen.has(key)) {
                        seen.add(key);
                        const size = f.filesize ? ` (${formatFileSize(f.filesize)})` : '';
                        qualitySelect.innerHTML += `<option value="${f.formatId}">${f.resolution} ${f.ext}${size}</option>`;
                    }
                });
        } else {
            qualitySelector.style.display = 'none';
        }
    }

    showParserProgress(false);
    modal.classList.add('show');
}

/**
 * 确认加载解析的视频
 */
async function confirmLoadParsedVideo() {
    if (!pendingParseResult) return;

    const { info, url } = pendingParseResult;
    const quality = document.getElementById('parser-quality-select')?.value || 'best';

    hideParserModal();

    // 如果是通用解析器已经返回了直接 URL，直接使用
    if (info.directUrl) {
        const videoUrl = info.directUrl;

        // 通知房间更换视频
        socket.emit('change-video', {
            url: videoUrl,
            title: info.title
        });

        // 清空输入框
        document.getElementById('parser-url-input').value = '';
        showToast('视频加载成功', 'success');
        return;
    }

    showParserProgress(true);
    updateParserProgress(35, '正在获取视频源...');

    // 禁用按钮
    const parseBtn = document.getElementById('parse-video-btn');
    if (parseBtn) {
        parseBtn.disabled = true;
        parseBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 加载中';
    }

    try {
        const res = await fetch('/api/parser/parse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url,
                roomId,
                quality: quality === 'best' ? 'best[ext=mp4]/best' : quality,
                forceDownload: false
            })
        });

        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error);
        }

        // 更新进度
        updateParserProgress(100, '加载完成');

        // 处理 MSE 模式（分离音视频，如 YouTube）
        if (data.data.type === 'mse') {
            // MSE 模式需要代理音视频 URL
            const proxyVideoUrl = data.data.needsProxy
                ? `/api/parser/proxy?url=${encodeURIComponent(data.data.videoUrl)}`
                : data.data.videoUrl;
            const proxyAudioUrl = data.data.needsProxy
                ? `/api/parser/proxy?url=${encodeURIComponent(data.data.audioUrl)}`
                : data.data.audioUrl;

            // 通知房间使用 MSE 模式更换视频
            socket.emit('change-video', {
                url: proxyVideoUrl,
                title: data.data.title,
                mseData: {
                    videoUrl: proxyVideoUrl,
                    audioUrl: proxyAudioUrl
                }
            });
        } else {
            // 获取视频 URL
            let videoUrl = data.data.url;

            // 如果需要代理（防盗链）
            if (data.data.needsProxy && data.data.type === 'direct') {
                videoUrl = `/api/parser/proxy?url=${encodeURIComponent(videoUrl)}`;
            }

            // 通知房间更换视频
            socket.emit('change-video', {
                url: videoUrl,
                title: data.data.title
            });
        }

        // 清空输入框
        document.getElementById('parser-url-input').value = '';
        showToast('视频加载成功', 'success');

        // 延迟隐藏进度条
        setTimeout(() => showParserProgress(false), 500);

    } catch (err) {
        showToast(err.message || '加载视频失败', 'error');
        showParserProgress(false);
    } finally {
        // 恢复按钮
        if (parseBtn) {
            parseBtn.disabled = false;
            parseBtn.innerHTML = '<span>解析视频</span>';
        }
    }
}

/**
 * 处理解析进度
 */
function handleParserProgress(data) {
    updateParserProgress(data.progress, data.message);

    if (data.stage === 'complete') {
        setTimeout(() => showParserProgress(false), 1000);
    } else if (data.stage === 'error') {
        showToast(data.message, 'error');
        showParserProgress(false);
    }
}

/**
 * 显示/隐藏解析进度条
 */
function showParserProgress(show) {
    const container = document.getElementById('parser-progress-container');
    if (container) container.style.display = show ? 'flex' : 'none';
}

/**
 * 更新解析进度
 */
function updateParserProgress(percent, message) {
    const bar = document.getElementById('parser-progress-bar');
    const text = document.getElementById('parser-progress-text');
    const percentText = document.getElementById('parser-progress-percent');

    if (bar) {
        bar.style.width = `${percent}%`;
        // Error state handling
        if (message && (message.includes('失败') || message.includes('错误') || message.includes('Error'))) {
            bar.parentElement.parentElement.classList.add('error');
        } else {
            bar.parentElement.parentElement.classList.remove('error');
        }
    }
    if (text) text.textContent = message;
    if (percentText) percentText.textContent = `${percent}%`;
}

/**
 * 隐藏预览弹窗
 */
function hideParserModal() {
    document.getElementById('parser-preview-modal')?.classList.remove('show');
    pendingParseResult = null;
}

/**
 * 显示支持的网站列表
 */
async function showSupportedSites() {
    const modal = document.getElementById('parser-sites-modal');
    const grid = document.getElementById('parser-sites-grid');

    // 如果还没有加载，先加载
    if (parserSupportedSites.length === 0) {
        await loadSupportedSites();
    }

    // 填充网站列表
    grid.innerHTML = parserSupportedSites.map(site => `
        <div class="parser-site-item">
            <i class="${site.icon || 'fas fa-play-circle'}"></i>
            <span>${site.name}</span>
        </div>
    `).join('');

    modal.classList.add('show');
}

/**
 * 隐藏支持网站弹窗
 */
function hideParserSitesModal() {
    document.getElementById('parser-sites-modal')?.classList.remove('show');
}

/**
 * 格式化秒数为时长字符串
 */
function formatDurationSeconds(seconds) {
    if (!seconds || seconds <= 0) return '未知';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let unitIndex = 0;
    let size = bytes;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

// ==========================================
// 屏幕共享功能
// ==========================================

// 屏幕共享设置
let screenShareSettings = {
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrate: 5000 // Kbps
};

/**
 * 显示屏幕共享设置弹窗
 */
function showScreenShareSettingsModal() {
    if (isScreenSharing) {
        showToast('你已经在共享屏幕', 'warning');
        return;
    }

    if (currentSharer) {
        showToast(`${currentSharer.name} 正在共享屏幕`, 'warning');
        return;
    }

    const modal = document.getElementById('screen-share-settings-modal');
    modal.classList.add('show');
    updateSettingsPreview();
}

/**
 * 隐藏屏幕共享设置弹窗
 */
function hideScreenShareSettingsModal() {
    const modal = document.getElementById('screen-share-settings-modal');
    modal.classList.remove('show');
}

/**
 * 更新设置预览文本
 */
function updateSettingsPreview() {
    const preview = document.getElementById('settings-preview-text');
    const bitrateStr = screenShareSettings.bitrate >= 1000
        ? `${(screenShareSettings.bitrate / 1000).toFixed(1)} Mbps`
        : `${screenShareSettings.bitrate} Kbps`;
    preview.textContent = `${screenShareSettings.width}×${screenShareSettings.height} @ ${screenShareSettings.frameRate}fps, ${bitrateStr}`;
}

/**
 * 初始化屏幕共享设置弹窗交互
 */
function initScreenShareSettingsModal() {
    const modal = document.getElementById('screen-share-settings-modal');
    if (!modal) return;

    // 关闭按钮
    document.getElementById('screen-share-settings-close')?.addEventListener('click', hideScreenShareSettingsModal);
    document.getElementById('screen-share-cancel-btn')?.addEventListener('click', hideScreenShareSettingsModal);

    // 点击背景关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) hideScreenShareSettingsModal();
    });

    // 开始共享按钮
    document.getElementById('screen-share-start-btn')?.addEventListener('click', () => {
        hideScreenShareSettingsModal();
        startScreenShareWithSettings();
    });

    // 分辨率预设按钮
    initPresetButtons('resolution-presets', 'resolution-custom', (value) => {
        if (value !== 'custom') {
            const [w, h] = value.split('x').map(Number);
            screenShareSettings.width = w;
            screenShareSettings.height = h;
        }
        updateSettingsPreview();
    });

    // 帧率预设按钮
    initPresetButtons('framerate-presets', 'framerate-custom', (value) => {
        if (value !== 'custom') {
            screenShareSettings.frameRate = parseInt(value);
        }
        updateSettingsPreview();
    });

    // 码率预设按钮
    initPresetButtons('bitrate-presets', 'bitrate-custom', (value) => {
        if (value !== 'custom') {
            screenShareSettings.bitrate = parseInt(value);
        }
        updateSettingsPreview();
    });

    // 自定义输入监听
    document.getElementById('custom-width')?.addEventListener('input', (e) => {
        screenShareSettings.width = parseInt(e.target.value) || 1920;
        updateSettingsPreview();
    });
    document.getElementById('custom-height')?.addEventListener('input', (e) => {
        screenShareSettings.height = parseInt(e.target.value) || 1080;
        updateSettingsPreview();
    });
    document.getElementById('custom-framerate')?.addEventListener('input', (e) => {
        screenShareSettings.frameRate = parseInt(e.target.value) || 30;
        updateSettingsPreview();
    });
    document.getElementById('custom-bitrate')?.addEventListener('input', (e) => {
        screenShareSettings.bitrate = parseInt(e.target.value) || 5000;
        updateSettingsPreview();
    });
}

/**
 * 初始化预设按钮组
 */
function initPresetButtons(presetsId, customRowId, onChange) {
    const container = document.getElementById(presetsId);
    const customRow = document.getElementById(customRowId);
    if (!container) return;

    container.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            // 移除其他按钮的 active
            container.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const value = btn.dataset.value;

            // 显示/隐藏自定义输入
            if (customRow) {
                customRow.style.display = value === 'custom' ? 'flex' : 'none';
            }

            onChange(value);
        });
    });
}

/**
 * 开始屏幕共享（应用设置）
 */
async function startScreenShareWithSettings() {
    if (isScreenSharing) {
        showToast('你已经在共享屏幕', 'warning');
        return;
    }

    if (currentSharer) {
        showToast(`${currentSharer.name} 正在共享屏幕`, 'warning');
        return;
    }

    try {
        // 获取屏幕流，应用分辨率和帧率约束
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: 'always',
                width: { ideal: screenShareSettings.width },
                height: { ideal: screenShareSettings.height },
                frameRate: { ideal: screenShareSettings.frameRate }
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true
            }
        });

        // 监听用户停止共享（点击浏览器的“停止共享”按钮）
        screenStream.getVideoTracks()[0].onended = () => {
            stopScreenShare();
        };

        // 通知服务器开始共享
        socket.emit('screen-share-start', (response) => {
            if (response.success) {
                isScreenSharing = true;
                updateScreenShareUI(true);
                const bitrateStr = screenShareSettings.bitrate >= 1000
                    ? `${(screenShareSettings.bitrate / 1000).toFixed(1)} Mbps`
                    : `${screenShareSettings.bitrate} Kbps`;
                showToast(`开始共享 (${screenShareSettings.width}×${screenShareSettings.height}, ${screenShareSettings.frameRate}fps, ${bitrateStr})`, 'success');
                console.log('[屏幕共享] 开始共享，设置:', screenShareSettings);
            } else {
                // 失败，释放流
                screenStream.getTracks().forEach(track => track.stop());
                screenStream = null;
                showToast(response.error || '无法开始屏幕共享', 'error');
            }
        });

    } catch (err) {
        console.error('[屏幕共享] 获取屏幕流失败:', err);
        if (err.name === 'NotAllowedError') {
            showToast('屏幕共享已取消', 'info');
        } else {
            showToast('无法获取屏幕流', 'error');
        }
    }
}

/**
 * 开始屏幕共享（兼容旧接口，现在改为显示设置弹窗）
 */
function startScreenShare() {
    showScreenShareSettingsModal();
}

/**
 * 停止屏幕共享
 */
function stopScreenShare() {
    if (!isScreenSharing) return;

    // 停止屏幕流
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }

    // 关闭所有 P2P 连接
    peerConnections.forEach((pc, peerId) => {
        pc.close();
    });
    peerConnections.clear();

    isScreenSharing = false;
    updateScreenShareUI(false);

    // 通知服务器
    socket.emit('screen-share-stop');
    showToast('已停止屏幕共享', 'info');
    console.log('[屏幕共享] 停止共享');
}

/**
 * 为新观看者创建 P2P 连接并发送 offer
 */
async function createOfferForViewer(viewerId, viewerName) {
    if (!screenStream) return;

    console.log(`[屏幕共享] 为观看者 ${viewerName} 创建连接`);

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections.set(viewerId, pc);

    // 添加屏幕流轨道
    screenStream.getTracks().forEach(track => {
        pc.addTrack(track, screenStream);
    });

    // 应用码率限制
    try {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
            const params = sender.getParameters();
            if (!params.encodings) {
                params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = screenShareSettings.bitrate * 1000; // Kbps to bps
            await sender.setParameters(params);
            console.log(`[屏幕共享] 应用码率限制: ${screenShareSettings.bitrate} Kbps`);
        }
    } catch (err) {
        console.warn('[屏幕共享] 设置码率失败:', err);
    }

    // ICE candidate 交换
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('screen-share-ice', {
                targetId: viewerId,
                candidate: event.candidate
            });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`[屏幕共享] 与 ${viewerName} 连接状态: ${pc.connectionState}`);
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            pc.close();
            peerConnections.delete(viewerId);
        }
    };

    // 创建并发送 offer
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.emit('screen-share-offer', {
            targetId: viewerId,
            offer: pc.localDescription
        });
    } catch (err) {
        console.error('[屏幕共享] 创建 offer 失败:', err);
    }
}

/**
 * 观看者处理收到的 offer
 */
async function handleScreenShareOffer(sharerId, sharerName, offer) {
    console.log(`[屏幕共享] 收到来自 ${sharerName} 的 offer`);

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections.set(sharerId, pc);

    // ICE candidate 交换
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('screen-share-ice', {
                targetId: sharerId,
                candidate: event.candidate
            });
        }
    };

    // 接收远程流
    pc.ontrack = (event) => {
        console.log('[屏幕共享] 收到远程流');
        const video = document.getElementById('screen-share-video');
        if (video && event.streams[0]) {
            video.srcObject = event.streams[0];
            showScreenShareContainer(true, sharerName);
            // 清除超时定时器
            if (pc._connectionTimeout) {
                clearTimeout(pc._connectionTimeout);
                pc._connectionTimeout = null;
            }
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`[屏幕共享] 与分享者连接状态: ${pc.connectionState}`);

        if (pc.connectionState === 'failed') {
            peerConnections.delete(sharerId);
            pc.close();

            // 自动重试
            if (connectionRetryCount < MAX_RETRY_COUNT) {
                connectionRetryCount++;
                showToast(`P2P 连接失败，正在重试 (${connectionRetryCount}/${MAX_RETRY_COUNT})...`, 'warning');
                setTimeout(() => {
                    socket.emit('screen-share-request');
                }, 1000);
            } else {
                showToast('P2P 连接失败，请检查网络环境', 'error');
                showConnectionRetryUI(sharerName);
            }
        } else if (pc.connectionState === 'disconnected') {
            showToast('屏幕共享连接已断开，尝试 ICE 重连...', 'warning');
            // 使用 ICE Restart 替代完全重连
            setTimeout(async () => {
                if (pc.connectionState === 'disconnected') {
                    const success = await performIceRestart(sharerId);
                    if (!success && currentSharer) {
                        // ICE Restart 失败，回退到完全重连
                        peerConnections.delete(sharerId);
                        pc.close();
                        socket.emit('screen-share-request');
                    }
                }
            }, 2000);
        } else if (pc.connectionState === 'connected') {
            connectionRetryCount = 0; // 连接成功，重置重试计数
            showToast('屏幕共享连接成功', 'success');
            hideConnectionRetryUI();
            // 启动连接质量监控
            startConnectionMonitor(pc, sharerId);
        }
    };

    // 连接超时检测（15秒）
    pc._connectionTimeout = setTimeout(() => {
        if (pc.connectionState !== 'connected' && pc.connectionState !== 'completed') {
            console.warn('[屏幕共享] 连接超时');
            peerConnections.delete(sharerId);
            pc.close();

            // 自动重试
            if (connectionRetryCount < MAX_RETRY_COUNT) {
                connectionRetryCount++;
                showToast(`P2P 连接超时，正在重试 (${connectionRetryCount}/${MAX_RETRY_COUNT})...`, 'warning');
                setTimeout(() => {
                    socket.emit('screen-share-request');
                }, 1000);
            } else {
                showToast('P2P 连接超时，可能是网络环境不支持直连', 'error');
                showConnectionRetryUI(sharerName);
            }
        }
    }, 15000);

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit('screen-share-answer', {
            targetId: sharerId,
            answer: pc.localDescription
        });
    } catch (err) {
        console.error('[屏幕共享] 处理 offer 失败:', err);
    }
}

/**
 * 分享者处理收到的 answer
 */
async function handleScreenShareAnswer(viewerId, answer) {
    const pc = peerConnections.get(viewerId);
    if (!pc) return;

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`[屏幕共享] 与观看者 ${viewerId} 连接已建立`);
    } catch (err) {
        console.error('[屏幕共享] 处理 answer 失败:', err);
    }
}

/**
 * 处理 ICE candidate
 */
async function handleScreenShareIce(fromId, candidate) {
    const pc = peerConnections.get(fromId);
    if (!pc) return;

    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error('[屏幕共享] 添加 ICE candidate 失败:', err);
    }
}

/**
 * ICE Restart - 更轻量的重连方式
 */
async function performIceRestart(peerId) {
    const pc = peerConnections.get(peerId);
    if (!pc) return false;

    try {
        console.log('[屏幕共享] 执行 ICE Restart');
        pc.restartIce();

        // 如果是分享者，需要创建新的 offer
        if (isScreenSharing) {
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);
            socket.emit('screen-share-offer', {
                targetId: peerId,
                offer: pc.localDescription
            });
        }
        return true;
    } catch (err) {
        console.error('[屏幕共享] ICE Restart 失败:', err);
        return false;
    }
}

/**
 * 启动连接质量监控
 */
function startConnectionMonitor(pc, peerId) {
    // 清除旧的监控
    stopConnectionMonitor();

    lastBytesReceived = 0;
    lastStatsTime = Date.now();

    statsInterval = setInterval(async () => {
        if (!pc || pc.connectionState !== 'connected') {
            stopConnectionMonitor();
            return;
        }

        try {
            const stats = await pc.getStats();
            let currentStats = {
                bytesReceived: 0,
                packetsLost: 0,
                packetsReceived: 0,
                roundTripTime: 0,
                jitter: 0
            };

            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    currentStats.bytesReceived = report.bytesReceived || 0;
                    currentStats.packetsLost = report.packetsLost || 0;
                    currentStats.packetsReceived = report.packetsReceived || 0;
                    currentStats.jitter = report.jitter || 0;
                }
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    currentStats.roundTripTime = report.currentRoundTripTime || 0;
                }
            });

            // 计算实时码率
            const now = Date.now();
            const timeDiff = (now - lastStatsTime) / 1000;
            const bytesDiff = currentStats.bytesReceived - lastBytesReceived;
            const bitrate = timeDiff > 0 ? (bytesDiff * 8 / timeDiff / 1000) : 0; // Kbps

            lastBytesReceived = currentStats.bytesReceived;
            lastStatsTime = now;

            // 计算丢包率
            const totalPackets = currentStats.packetsReceived + currentStats.packetsLost;
            const lossRate = totalPackets > 0 ? (currentStats.packetsLost / totalPackets * 100) : 0;

            // 更新 UI 显示
            updateConnectionQualityUI({
                bitrate: bitrate.toFixed(0),
                lossRate: lossRate.toFixed(1),
                rtt: (currentStats.roundTripTime * 1000).toFixed(0),
                jitter: (currentStats.jitter * 1000).toFixed(1)
            });

            // 自适应码率调整（仅分享者）
            if (isScreenSharing) {
                adjustBitrateBasedOnStats(lossRate, currentStats.roundTripTime * 1000);
            }

        } catch (err) {
            console.warn('[屏幕共享] 获取统计失败:', err);
        }
    }, 2000); // 每2秒更新一次
}

/**
 * 停止连接质量监控
 */
function stopConnectionMonitor() {
    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
    }
    hideConnectionQualityUI();
}

/**
 * 更新连接质量 UI
 */
function updateConnectionQualityUI(stats) {
    let qualityEl = document.getElementById('connection-quality-display');

    if (!qualityEl) {
        // 创建质量显示元素
        const overlay = document.getElementById('screen-share-overlay');
        if (!overlay) return;

        qualityEl = document.createElement('div');
        qualityEl.id = 'connection-quality-display';
        qualityEl.className = 'connection-quality';
        overlay.appendChild(qualityEl);
    }

    // 判断连接质量
    let quality = 'good';
    if (parseFloat(stats.lossRate) > 5 || parseFloat(stats.rtt) > 300) {
        quality = 'poor';
    } else if (parseFloat(stats.lossRate) > 2 || parseFloat(stats.rtt) > 150) {
        quality = 'fair';
    }

    qualityEl.innerHTML = `
        <span class="quality-indicator ${quality}"></span>
        <span class="quality-stats">
            ${stats.bitrate} Kbps | 丢包 ${stats.lossRate}% | 延迟 ${stats.rtt}ms
        </span>
    `;
    qualityEl.style.display = 'flex';
}

/**
 * 隐藏连接质量 UI
 */
function hideConnectionQualityUI() {
    const qualityEl = document.getElementById('connection-quality-display');
    if (qualityEl) {
        qualityEl.style.display = 'none';
    }
}

/**
 * 自适应码率调整
 */
async function adjustBitrateBasedOnStats(lossRate, rtt) {
    // 判断网络状况
    const isGood = lossRate < 1 && rtt < 100;
    const isBad = lossRate > 3 || rtt > 200;

    if (isGood) {
        consecutiveGoodStats++;
        consecutiveBadStats = 0;

        // 连续 5 次良好，尝试提升码率
        if (consecutiveGoodStats >= 5 && currentBitrateLevel < BITRATE_LEVELS.length - 1) {
            currentBitrateLevel++;
            await applyBitrateToAllConnections(BITRATE_LEVELS[currentBitrateLevel].bitrate);
            console.log(`[自适应码率] 提升至 ${BITRATE_LEVELS[currentBitrateLevel].label} (${BITRATE_LEVELS[currentBitrateLevel].bitrate} Kbps)`);
            consecutiveGoodStats = 0;
        }
    } else if (isBad) {
        consecutiveBadStats++;
        consecutiveGoodStats = 0;

        // 连续 2 次差，立即降低码率
        if (consecutiveBadStats >= 2 && currentBitrateLevel > 0) {
            currentBitrateLevel--;
            await applyBitrateToAllConnections(BITRATE_LEVELS[currentBitrateLevel].bitrate);
            showToast(`网络波动，已降低码率至 ${BITRATE_LEVELS[currentBitrateLevel].label}`, 'warning');
            console.log(`[自适应码率] 降低至 ${BITRATE_LEVELS[currentBitrateLevel].label} (${BITRATE_LEVELS[currentBitrateLevel].bitrate} Kbps)`);
            consecutiveBadStats = 0;
        }
    } else {
        // 中等状况，重置计数
        consecutiveGoodStats = 0;
        consecutiveBadStats = 0;
    }
}

/**
 * 应用码率到所有连接
 */
async function applyBitrateToAllConnections(bitrateKbps) {
    for (const [peerId, pc] of peerConnections) {
        try {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }
                params.encodings[0].maxBitrate = bitrateKbps * 1000;
                await sender.setParameters(params);
            }
        } catch (err) {
            console.warn(`[自适应码率] 设置 ${peerId} 码率失败:`, err);
        }
    }
}

/**
 * 更新屏幕共享按钮 UI
 */
function updateScreenShareUI(sharing) {
    const btn = document.getElementById('screen-share-btn');
    if (!btn) return;

    if (sharing) {
        btn.classList.add('sharing');
        btn.innerHTML = '<i class="fa-solid fa-display"></i><span>停止共享</span>';
        btn.title = '停止屏幕共享';
    } else {
        btn.classList.remove('sharing');
        btn.innerHTML = '<i class="fa-solid fa-display"></i><span>共享屏幕</span>';
        btn.title = '共享屏幕';
    }
}

/**
 * 显示/隐藏屏幕共享播放器容器
 */
function showScreenShareContainer(show, sharerName = '') {
    // 更改为使用 screen-share-overlay
    const container = document.getElementById('screen-share-overlay');
    const nameSpan = container?.querySelector('.sharer-name');

    if (!container) return;

    if (show) {
        container.style.display = 'flex';
        // 如果正在播放视频，暂停它
        if (player && !player.paused()) {
            player.pause();
        }
        if (nameSpan) nameSpan.textContent = sharerName;
        hideConnectionRetryUI(); // 隐藏重试按钮
    } else {
        container.style.display = 'none';
        const video = document.getElementById('screen-share-video');
        if (video) video.srcObject = null;
        hideConnectionRetryUI();
    }
}

/**
 * 显示连接重试界面
 */
function showConnectionRetryUI(sharerName) {
    const container = document.getElementById('screen-share-overlay');
    if (!container) return;

    container.style.display = 'flex';

    // 创建或更新重试提示
    let retryOverlay = container.querySelector('.retry-overlay');
    if (!retryOverlay) {
        retryOverlay = document.createElement('div');
        retryOverlay.className = 'retry-overlay';
        retryOverlay.innerHTML = `
            <div class="retry-content">
                <i class="fa-solid fa-wifi-slash"></i>
                <h3>连接失败</h3>
                <p>无法建立 P2P 连接，可能是网络环境限制</p>
                <div class="retry-buttons">
                    <button class="btn btn-primary" id="retry-connect-btn">
                        <i class="fa-solid fa-rotate-right"></i> 重新连接
                    </button>
                    <button class="btn btn-secondary" id="retry-cancel-btn">
                        取消
                    </button>
                </div>
            </div>
        `;
        container.appendChild(retryOverlay);

        // 绑定事件
        retryOverlay.querySelector('#retry-connect-btn').addEventListener('click', () => {
            hideConnectionRetryUI();
            connectionRetryCount = 0;
            if (currentSharer) {
                showToast('正在重新连接...', 'info');
                socket.emit('screen-share-request');
            }
        });

        retryOverlay.querySelector('#retry-cancel-btn').addEventListener('click', () => {
            showScreenShareContainer(false);
        });
    }

    retryOverlay.style.display = 'flex';
}

/**
 * 隐藏连接重试界面
 */
function hideConnectionRetryUI() {
    const retryOverlay = document.querySelector('.retry-overlay');
    if (retryOverlay) {
        retryOverlay.style.display = 'none';
    }
}

/**
 * 处理屏幕共享停止（观看者角度）
 */
function handleScreenShareStopped(stoppedBy, reason) {
    // 停止连接质量监控
    stopConnectionMonitor();

    // 关闭 P2P 连接
    peerConnections.forEach((pc) => pc.close());
    peerConnections.clear();

    currentSharer = null;
    showScreenShareContainer(false);

    if (reason === 'disconnected') {
        showNotification(`${stoppedBy} 断开连接，屏幕共享已结束`);
    } else {
        showNotification(`${stoppedBy} 停止了屏幕共享`);
    }
}


// 全局函数：加入屏幕共享
window.joinScreenShare = function () {
    if (isScreenSharing) {
        showToast('你正在共享屏幕，无法观看自己', 'warning');
        return;
    }
    if (!currentSharer) {
        showToast('当前无人共享屏幕', 'warning');
        return;
    }
    showScreenShareContainer(true, currentSharer.name);
    // 如果没有连接，重新请求
    if (peerConnections.size === 0) {
        socket.emit('screen-share-request');
    }
};

/**
 * 屏幕共享音量控制
 */
function handleScreenShareVolume(e) {
    const video = document.getElementById('screen-share-video');
    const volumeIcon = document.getElementById('screen-share-volume-icon');
    if (!video) return;

    const volume = parseFloat(e.target.value);
    video.volume = volume;
    video.muted = (volume === 0);

    // 更新图标
    if (volume === 0) {
        volumeIcon.className = 'fa-solid fa-volume-xmark';
    } else if (volume < 0.5) {
        volumeIcon.className = 'fa-solid fa-volume-low';
    } else {
        volumeIcon.className = 'fa-solid fa-volume-high';
    }
}

/**
 * 切换屏幕共享全屏
 */
function toggleScreenShareFullscreen() {
    const container = document.getElementById('screen-share-overlay');
    if (!container) return;

    if (!document.fullscreenElement) {
        container.requestFullscreen().catch(err => {
            console.error('全屏失败:', err);
        });
    } else {
        document.exitFullscreen();
    }
}

/**
 * 初始化屏幕共享事件监听
 */
function initScreenShareListeners() {
    // 初始化设置弹窗
    initScreenShareSettingsModal();

    // 共享按钮点击
    const shareBtn = document.getElementById('screen-share-btn');
    if (shareBtn) {
        shareBtn.addEventListener('click', () => {
            if (isScreenSharing) {
                stopScreenShare();
            } else {
                startScreenShare();
            }
        });
    }

    // 绑定其他控制按钮 (需在 overlay 更新 HTML 后绑定，或者在这里通过 document 代理绑定)
    // 更新 overlay HTML 结构以包含按钮
    const overlay = document.getElementById('screen-share-overlay');
    if (overlay) {
        const controlsDiv = overlay.querySelector('.screen-share-controls');
        // 添加音量和全屏按钮
        if (controlsDiv && !controlsDiv.querySelector('.extra-controls')) {
            const extraControls = document.createElement('div');
            extraControls.className = 'extra-controls';
            extraControls.innerHTML = `
                <div class="volume-control-group">
                    <button class="control-btn" id="screen-share-volume-btn" title="静音/取消静音">
                        <i class="fa-solid fa-volume-high" id="screen-share-volume-icon"></i>
                    </button>
                    <input type="range" class="volume-slider" id="screen-share-volume-slider" min="0" max="1" step="0.1" value="1">
                </div>
                <button class="control-btn" id="screen-share-fullscreen" title="全屏">
                    <i class="fa-solid fa-expand"></i>
                </button>
             `;
            // 插入到 sharer-info 后面
            const sharerInfo = controlsDiv.querySelector('.sharer-info');
            if (sharerInfo) {
                sharerInfo.insertAdjacentElement('afterend', extraControls);
            }

            // 绑定事件
            document.getElementById('screen-share-volume-slider')?.addEventListener('input', handleScreenShareVolume);
            const volBtn = document.getElementById('screen-share-volume-btn');
            if (volBtn) {
                volBtn.addEventListener('click', () => {
                    const video = document.getElementById('screen-share-video');
                    const slider = document.getElementById('screen-share-volume-slider');
                    if (video && slider) {
                        video.muted = !video.muted;
                        if (video.muted) {
                            slider.value = 0;
                            handleScreenShareVolume({ target: slider });
                        } else {
                            // 如果之前是静音，恢复到上次的音量，或者默认1
                            slider.value = video.volume > 0 ? video.volume : 1;
                            handleScreenShareVolume({ target: slider });
                        }
                    }
                });
            }
            document.getElementById('screen-share-fullscreen')?.addEventListener('click', toggleScreenShareFullscreen);
        }
    }

    // Socket 事件
    socket.on('screen-share-started', ({ sharerId, sharerName }) => {
        console.log(`[屏幕共享] 收到 screen-share-started: ${sharerName} (${sharerId})`);
        currentSharer = { id: sharerId, name: sharerName };

        // 强制刷新用户列表以显示"共享中"徽章
        // 我们需要最新的用户列表，如果本地没有完整的用户列表对象，可能需要请求服务器
        // 但通常 userList 应该在本地有缓存吗？ 
        // 实际上 updateUserList 是在收到 user-update 事件时调用的，参数是 users 数组。
        // 这里我们没有 users 数组，无法直接调用 updateUserList(users)。
        // 解决方案：通知服务器广播更新后的用户列表，或者请求更新。
        socket.emit('request-user-list');

        showNotification(`${sharerName} 开始共享屏幕`);
        // 请求接收共享
        socket.emit('screen-share-request');
        console.log('[屏幕共享] 已发送 screen-share-request');
    });

    socket.on('screen-share-viewer-joined', ({ viewerId, viewerName }) => {
        console.log(`[屏幕共享] 收到 screen-share-viewer-joined: ${viewerName} (${viewerId})`);
        // 分享者收到新观看者，创建 offer
        if (isScreenSharing) {
            console.log('[屏幕共享] 正在为观看者创建 offer...');
            createOfferForViewer(viewerId, viewerName);
        } else {
            console.log('[屏幕共享] 警告: 收到 viewer-joined 但未在共享状态');
        }
    });

    socket.on('screen-share-offer', ({ sharerId, sharerName, offer }) => {
        console.log(`[屏幕共享] 收到 screen-share-offer from ${sharerName}`);
        handleScreenShareOffer(sharerId, sharerName, offer);
    });

    socket.on('screen-share-answer', ({ viewerId, answer }) => {
        console.log(`[屏幕共享] 收到 screen-share-answer from ${viewerId}`);
        handleScreenShareAnswer(viewerId, answer);
    });

    socket.on('screen-share-ice', ({ fromId, candidate }) => {
        console.log(`[屏幕共享] 收到 ICE candidate from ${fromId}`);
        handleScreenShareIce(fromId, candidate);
    });

    socket.on('screen-share-stopped', ({ stoppedBy, reason }) => {
        console.log(`[屏幕共享] 收到 screen-share-stopped: ${stoppedBy}, reason: ${reason}`);
        handleScreenShareStopped(stoppedBy, reason);
        // 更新用户列表（移除徽章）
        socket.emit('request-user-list');
    });

    // 同步用户列表
    socket.on('sync-user-list', ({ userList }) => {
        updateUserList(userList);
    });
}

// 在 socket 初始化后调用屏幕共享初始化
const originalInitSocket = initSocket;
initSocket = function () {
    originalInitSocket();
    // 立即初始化屏幕共享监听（不等待 connect 事件，避免竞态）
    setTimeout(() => {
        if (socket) {
            initScreenShareListeners();
            console.log('[屏幕共享] 事件监听器已初始化');
        }
    }, 100);
};

// ==========================================
// 解析规则管理
// ==========================================

let loadedRules = [];  // 已加载的规则

/**
 * 初始化规则管理弹窗
 */
function initRulesModal() {
    // 关闭按钮
    document.getElementById('rules-modal-close')?.addEventListener('click', hideRulesModal);
    document.getElementById('rules-modal-ok-btn')?.addEventListener('click', hideRulesModal);

    // 标签页切换
    document.querySelectorAll('.rules-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;
            switchRulesTab(targetTab);
        });
    });

    // 重新加载规则
    document.getElementById('reload-rules-btn')?.addEventListener('click', reloadRules);

    // 添加规则
    document.getElementById('add-rule-btn')?.addEventListener('click', addRule);

    // 测试规则
    document.getElementById('test-rule-btn')?.addEventListener('click', testRule);
}

/**
 * 显示规则管理弹窗
 */
function showRulesModal() {
    const modal = document.getElementById('parser-rules-modal');
    if (modal) {
        modal.classList.add('show');
        loadRulesList();
    }
}

/**
 * 隐藏规则管理弹窗
 */
function hideRulesModal() {
    const modal = document.getElementById('parser-rules-modal');
    if (modal) {
        modal.classList.remove('show');
    }
}

/**
 * 切换标签页
 */
function switchRulesTab(tabName) {
    // 更新标签按钮状态
    document.querySelectorAll('.rules-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    // 更新内容显示
    document.querySelectorAll('.rules-tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `rules-tab-${tabName}`);
    });
}

/**
 * 加载规则列表
 */
async function loadRulesList() {
    const listEl = document.getElementById('rules-list');
    const countEl = document.getElementById('rules-count');

    if (!listEl) return;

    listEl.innerHTML = '<div class="rules-loading"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>';

    try {
        const res = await fetch('/api/parser/rules');
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || '加载失败');
        }

        loadedRules = data.rules || [];
        countEl.textContent = `已加载 ${loadedRules.length} 条规则`;

        if (loadedRules.length === 0) {
            listEl.innerHTML = `
                <div class="rules-empty">
                    <i class="fa-solid fa-puzzle-piece"></i>
                    <p>暂无解析规则</p>
                    <p>点击"添加规则"开始创建</p>
                </div>
            `;
            return;
        }

        listEl.innerHTML = loadedRules.map(rule => `
            <div class="rule-item" data-file="${rule.file}">
                <div class="rule-item-info">
                    <div class="rule-item-header">
                        <span class="rule-item-name">${escapeHtml(rule.name)}</span>
                        <span class="rule-item-badge ${rule.source}">${rule.source === 'system' ? '系统' : '用户'}</span>
                        <span class="rule-item-badge priority">优先级 ${rule.priority}</span>
                        <span class="rule-item-version">v${rule.version}</span>
                    </div>
                    <div class="rule-item-desc">${escapeHtml(rule.description || '无描述')}</div>
                    <div class="rule-item-meta">
                        <span><i class="fa-solid fa-globe"></i> ${rule.domains.slice(0, 3).join(', ')}${rule.domains.length > 3 ? '...' : ''}</span>
                        ${rule.author ? `<span><i class="fa-solid fa-user"></i> ${escapeHtml(rule.author)}</span>` : ''}
                    </div>
                </div>
                <div class="rule-item-actions">
                    ${rule.source === 'user' ? `
                        <button class="rule-action-btn delete" onclick="deleteRule('${rule.file}')" title="删除规则">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    ` : ''}
                </div>
            </div>
        `).join('');

    } catch (err) {
        listEl.innerHTML = `
            <div class="rules-empty">
                <i class="fa-solid fa-exclamation-triangle"></i>
                <p>加载失败: ${escapeHtml(err.message)}</p>
            </div>
        `;
    }
}

/**
 * 重新加载规则
 */
async function reloadRules() {
    const btn = document.getElementById('reload-rules-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 加载中';
    }

    try {
        const res = await fetch('/api/parser/rules/reload', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            showToast(`已重新加载 ${data.count} 条规则`, 'success');
            loadRulesList();
        } else {
            throw new Error(data.error);
        }
    } catch (err) {
        showToast('重新加载失败: ' + err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-rotate"></i> 重新加载';
        }
    }
}

/**
 * 添加规则
 */
async function addRule() {
    const filenameInput = document.getElementById('rule-filename');
    const jsonInput = document.getElementById('rule-json');
    const btn = document.getElementById('add-rule-btn');

    const filename = filenameInput?.value.trim();
    const jsonStr = jsonInput?.value.trim();

    if (!jsonStr) {
        showToast('请输入规则 JSON', 'error');
        return;
    }

    // 解析 JSON
    let rule;
    try {
        rule = JSON.parse(jsonStr);
    } catch (err) {
        showToast('JSON 格式错误: ' + err.message, 'error');
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 添加中';
    }

    try {
        const res = await fetch('/api/parser/rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rule, filename: filename || undefined })
        });

        const data = await res.json();

        if (data.success) {
            showToast('规则添加成功', 'success');
            filenameInput.value = '';
            jsonInput.value = '';
            switchRulesTab('list');
            loadRulesList();
        } else {
            throw new Error(data.error);
        }
    } catch (err) {
        showToast('添加失败: ' + err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-plus"></i> 添加规则';
        }
    }
}

/**
 * 删除规则
 */
async function deleteRule(filename) {
    if (!confirm(`确定要删除规则 "${filename}" 吗？`)) {
        return;
    }

    try {
        const res = await fetch(`/api/parser/rules/${encodeURIComponent(filename)}`, {
            method: 'DELETE'
        });

        const data = await res.json();

        if (data.success) {
            showToast('规则已删除', 'success');
            loadRulesList();
        } else {
            throw new Error(data.error);
        }
    } catch (err) {
        showToast('删除失败: ' + err.message, 'error');
    }
}

/**
 * 测试规则
 */
async function testRule() {
    const urlInput = document.getElementById('test-url');
    const jsonInput = document.getElementById('test-rule-json');
    const resultEl = document.getElementById('test-result');
    const resultContent = document.getElementById('test-result-content');
    const btn = document.getElementById('test-rule-btn');

    const testUrl = urlInput?.value.trim();
    const jsonStr = jsonInput?.value.trim();

    if (!testUrl) {
        showToast('请输入测试 URL', 'error');
        return;
    }

    // 如果提供了 JSON，解析它
    let rule = null;
    if (jsonStr) {
        try {
            rule = JSON.parse(jsonStr);
        } catch (err) {
            showToast('规则 JSON 格式错误: ' + err.message, 'error');
            return;
        }
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试中';
    }

    resultEl.style.display = 'none';

    try {
        let res, data;

        if (rule) {
            // 测试自定义规则
            res = await fetch('/api/parser/rules/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rule, testUrl })
            });
            data = await res.json();
        } else {
            // 使用已有规则解析
            res = await fetch('/api/parser/info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: testUrl })
            });
            data = await res.json();
        }

        resultEl.style.display = 'block';

        if (data.success) {
            resultEl.classList.remove('error');
            resultEl.querySelector('h4').innerHTML = '<i class="fa-solid fa-check-circle"></i> 测试成功';
            resultContent.textContent = JSON.stringify(data.result || data.data, null, 2);
        } else {
            resultEl.classList.add('error');
            resultEl.querySelector('h4').innerHTML = '<i class="fa-solid fa-exclamation-circle"></i> 测试失败';
            resultContent.textContent = data.error || '未能提取到视频地址';
        }
    } catch (err) {
        resultEl.style.display = 'block';
        resultEl.classList.add('error');
        resultEl.querySelector('h4').innerHTML = '<i class="fa-solid fa-exclamation-circle"></i> 测试失败';
        resultContent.textContent = err.message;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-play"></i> 测试解析';
        }
    }
}

/**
 * HTML 转义
 */
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
