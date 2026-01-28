/**
 * RTMP 服务器模块
 * 接收 OBS 推流，转换为 HLS 供浏览器播放
 */

const NodeMediaServer = require('node-media-server');
const path = require('path');
const fs = require('fs');

// 直播文件存储目录 (使用 uploads 目录本身作为 mediaroot)
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const LIVE_DIR = path.join(UPLOADS_DIR, 'live');

// 确保直播目录存在
if (!fs.existsSync(LIVE_DIR)) {
    fs.mkdirSync(LIVE_DIR, { recursive: true });
}

// 存储活跃的推流会话 { streamKey -> { roomId, socketId, startedAt } }
const activeStreams = new Map();

// 回调函数存储
let onStreamStart = null;
let onStreamEnd = null;

// 检测 FFmpeg 路径
function detectFfmpegPath() {
    const { execSync } = require('child_process');
    const possiblePaths = [
        '/usr/local/bin/ffmpeg',
        '/opt/homebrew/bin/ffmpeg',
        '/usr/bin/ffmpeg',
        'ffmpeg' // fallback to PATH
    ];

    for (const ffmpegPath of possiblePaths) {
        try {
            execSync(`${ffmpegPath} -version`, { stdio: 'ignore' });
            console.log(`[RTMP] 检测到 FFmpeg: ${ffmpegPath}`);
            return ffmpegPath;
        } catch (e) {
            // continue to next path
        }
    }
    console.warn('[RTMP] 警告: 未检测到 FFmpeg，HLS 转码将无法工作');
    return 'ffmpeg';
}

const FFMPEG_PATH = detectFfmpegPath();

/**
 * node-media-server 配置
 */
const config = {
    rtmp: {
        port: 1935,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60
    },
    http: {
        port: 8888,
        mediaroot: UPLOADS_DIR, // 使用 uploads 作为 mediaroot
        allow_origin: '*'
    },
    trans: {
        ffmpeg: FFMPEG_PATH,
        tasks: [
            {
                app: 'live',
                hls: true,
                hlsFlags: '[hls_time=2:hls_list_size=5:hls_flags=delete_segments+append_list]',
                hlsKeep: false, // 直播结束后删除 HLS 文件
                dash: false
            }
        ]
    },
    logType: 4 // 1: Fatal, 2: Error, 3: Normal, 4: Debug (启用调试日志)
};

let nms = null;

/**
 * 启动 RTMP 服务器
 * @param {Object} callbacks - 回调函数
 * @param {Function} callbacks.onStreamStart - 推流开始回调
 * @param {Function} callbacks.onStreamEnd - 推流结束回调
 */
function start(callbacks = {}) {
    onStreamStart = callbacks.onStreamStart || null;
    onStreamEnd = callbacks.onStreamEnd || null;

    nms = new NodeMediaServer(config);

    // 推流前验证
    nms.on('prePublish', (id, streamPath, args) => {
        console.log('[RTMP] 推流请求:', streamPath, 'Session:', id);

        // streamPath 格式: /live/{streamKey}
        const parts = streamPath.split('/');
        const streamKey = parts[parts.length - 1];

        // 检查 streamKey 是否已注册
        const streamInfo = activeStreams.get(streamKey);
        if (!streamInfo) {
            console.log('[RTMP] 拒绝未注册的推流:', streamKey);
            const session = nms.getSession(id);
            if (session) {
                session.reject();
            }
            return;
        }

        console.log('[RTMP] 推流已验证:', streamKey, '房间:', streamInfo.roomId);

        // 更新推流状态
        streamInfo.isLive = true;
        streamInfo.sessionId = id;
        activeStreams.set(streamKey, streamInfo);

        // 触发回调 - HLS 文件路径: uploads/live/{streamKey}/index.m3u8
        if (onStreamStart) {
            const hlsUrl = `/uploads/live/${streamKey}/index.m3u8`;
            onStreamStart({
                streamKey,
                roomId: streamInfo.roomId,
                socketId: streamInfo.socketId,
                hlsUrl
            });
        }
    });

    // 推流结束
    nms.on('donePublish', (id, streamPath, args) => {
        console.log('[RTMP] 推流结束:', streamPath);

        const parts = streamPath.split('/');
        const streamKey = parts[parts.length - 1];

        const streamInfo = activeStreams.get(streamKey);
        if (streamInfo) {
            // 触发回调
            if (onStreamEnd) {
                onStreamEnd({
                    streamKey,
                    roomId: streamInfo.roomId,
                    socketId: streamInfo.socketId
                });
            }

            // 清理推流信息
            activeStreams.delete(streamKey);

            // 延迟清理 HLS 文件
            setTimeout(() => {
                cleanupStreamFiles(streamKey);
            }, 5000);
        }
    });

    // 连接事件
    nms.on('preConnect', (id, args) => {
        console.log('[RTMP] 客户端连接:', id);
    });

    nms.on('doneConnect', (id, args) => {
        console.log('[RTMP] 客户端断开:', id);
    });

    nms.run();
    console.log(`[RTMP] 服务器已启动，端口: ${config.rtmp.port}`);
}

/**
 * 停止 RTMP 服务器
 */
function stop() {
    if (nms) {
        nms.stop();
        nms = null;
        console.log('[RTMP] 服务器已停止');
    }
}

/**
 * 注册推流密钥
 * @param {string} streamKey - 推流密钥
 * @param {Object} info - 推流信息
 * @returns {Object} - RTMP 推流地址信息
 */
function registerStream(streamKey, info) {
    activeStreams.set(streamKey, {
        ...info,
        isLive: false,
        registeredAt: Date.now()
    });

    console.log('[RTMP] 注册推流密钥:', streamKey, '房间:', info.roomId);

    return {
        rtmpUrl: `rtmp://localhost:${config.rtmp.port}/live`,
        streamKey,
        hlsUrl: `/uploads/live/${streamKey}/index.m3u8`
    };
}

/**
 * 注销推流密钥
 * @param {string} streamKey - 推流密钥
 */
function unregisterStream(streamKey) {
    const streamInfo = activeStreams.get(streamKey);
    if (streamInfo) {
        // 如果正在推流，断开连接
        if (streamInfo.isLive && streamInfo.sessionId && nms) {
            const session = nms.getSession(streamInfo.sessionId);
            if (session) {
                session.reject();
            }
        }
        activeStreams.delete(streamKey);
        console.log('[RTMP] 注销推流密钥:', streamKey);
    }
}

/**
 * 获取推流状态
 * @param {string} streamKey - 推流密钥
 * @returns {Object|null} - 推流信息
 */
function getStreamStatus(streamKey) {
    return activeStreams.get(streamKey) || null;
}

/**
 * 根据房间 ID 获取推流信息
 * @param {string} roomId - 房间 ID
 * @returns {Object|null} - 推流信息
 */
function getStreamByRoomId(roomId) {
    for (const [streamKey, info] of activeStreams.entries()) {
        if (info.roomId === roomId && info.isLive) {
            return { streamKey, ...info };
        }
    }
    return null;
}

/**
 * 清理推流文件
 * @param {string} streamKey - 推流密钥
 */
function cleanupStreamFiles(streamKey) {
    const streamDir = path.join(LIVE_DIR, streamKey);
    if (fs.existsSync(streamDir)) {
        try {
            fs.rmSync(streamDir, { recursive: true, force: true });
            console.log('[RTMP] 已清理直播文件:', streamKey);
        } catch (err) {
            console.error('[RTMP] 清理直播文件失败:', err.message);
        }
    }
}

/**
 * 获取 RTMP 配置信息
 * @returns {Object} - 配置信息
 */
function getConfig() {
    return {
        rtmpPort: config.rtmp.port,
        httpPort: config.http.port
    };
}

module.exports = {
    start,
    stop,
    registerStream,
    unregisterStream,
    getStreamStatus,
    getStreamByRoomId,
    getConfig,
    LIVE_DIR
};
