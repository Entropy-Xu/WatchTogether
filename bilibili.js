/**
 * B 站 API 封装模块
 * 提供扫码登录、视频解析、播放地址获取等功能
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// 清晰度对照表
const QUALITY_MAP = {
    127: '8K 超高清',
    126: '杜比视界',
    125: 'HDR 真彩',
    120: '4K 超清',
    116: '1080P60',
    112: '1080P 高码率',
    80: '1080P',
    64: '720P',
    32: '480P',
    16: '360P'
};

// FFmpeg 路径 (使用系统 PATH)
const ffmpegPath = 'ffmpeg';

// 默认请求头
const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};

// Cookie 存储 (roomId -> cookie string)
const cookieStore = new Map();

// 合并任务缓存 (taskId -> { status, progress, outputPath })
const mergeTaskStore = new Map();

/**
 * 发起 HTTPS 请求
 */
function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const reqOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: {
                ...DEFAULT_HEADERS,
                ...options.headers
            }
        };

        const req = https.request(reqOptions, (res) => {
            let data = '';

            // 收集 Set-Cookie
            const cookies = res.headers['set-cookie'] || [];

            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ data: json, cookies, headers: res.headers });
                } catch {
                    resolve({ data, cookies, headers: res.headers });
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

/**
 * 下载文件到本地 (带重试机制和进度回调)
 */
function downloadFile(url, outputPath, cookie = '', retries = 3, onProgress = null) {
    return new Promise((resolve, reject) => {
        const attemptDownload = (attemptsLeft) => {
            const urlObj = new URL(url);
            const protocol = urlObj.protocol === 'https:' ? https : http;

            const headers = {
                ...DEFAULT_HEADERS,
                'Host': urlObj.host,
                'Connection': 'keep-alive'
            };
            if (cookie) headers['Cookie'] = cookie;

            // 如果文件存在，删除它
            if (fs.existsSync(outputPath)) {
                try { fs.unlinkSync(outputPath); } catch { }
            }

            const file = fs.createWriteStream(outputPath);

            const req = protocol.request({
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname + urlObj.search,
                method: 'GET',
                headers,
                timeout: 120000  // 120秒超时
            }, (res) => {
                // 跟随重定向
                if (res.statusCode === 302 || res.statusCode === 301) {
                    file.close();
                    try { fs.unlinkSync(outputPath); } catch { }
                    return downloadFile(res.headers.location, outputPath, cookie, attemptsLeft, onProgress)
                        .then(resolve)
                        .catch(reject);
                }

                const totalSize = parseInt(res.headers['content-length'], 10) || 0;
                let downloadedSize = 0;
                let lastReportTime = 0;

                res.on('data', (chunk) => {
                    downloadedSize += chunk.length;
                    // 每200ms最多报告一次进度，避免过于频繁
                    const now = Date.now();
                    if (onProgress && (now - lastReportTime > 200 || downloadedSize === totalSize)) {
                        lastReportTime = now;
                        onProgress({
                            downloaded: downloadedSize,
                            total: totalSize,
                            percent: totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0
                        });
                    }
                });

                res.on('error', (err) => {
                    file.close();
                    try { fs.unlinkSync(outputPath); } catch { }
                    if (attemptsLeft > 1) {
                        console.log(`[下载重试] 剩余 ${attemptsLeft - 1} 次`);
                        setTimeout(() => attemptDownload(attemptsLeft - 1), 1000);
                    } else {
                        reject(err);
                    }
                });

                res.pipe(file);

                file.on('finish', () => {
                    file.close();
                    resolve({ size: downloadedSize, totalSize });
                });

                file.on('error', (err) => {
                    file.close();
                    try { fs.unlinkSync(outputPath); } catch { }
                    if (attemptsLeft > 1) {
                        console.log(`[下载重试] 剩余 ${attemptsLeft - 1} 次`);
                        setTimeout(() => attemptDownload(attemptsLeft - 1), 1000);
                    } else {
                        reject(err);
                    }
                });
            });

            req.on('error', (err) => {
                file.close();
                try { fs.unlinkSync(outputPath); } catch { }
                if (attemptsLeft > 1) {
                    console.log(`[下载重试] ${err.message}, 剩余 ${attemptsLeft - 1} 次`);
                    setTimeout(() => attemptDownload(attemptsLeft - 1), 1000);
                } else {
                    reject(err);
                }
            });

            req.on('timeout', () => {
                req.destroy();
                file.close();
                try { fs.unlinkSync(outputPath); } catch { }
                if (attemptsLeft > 1) {
                    console.log(`[下载重试] 超时, 剩余 ${attemptsLeft - 1} 次`);
                    setTimeout(() => attemptDownload(attemptsLeft - 1), 1000);
                } else {
                    reject(new Error('下载超时'));
                }
            });

            req.end();
        };

        attemptDownload(retries);
    });
}

/**
 * 使用 FFmpeg 合并视频和音频
 */
async function mergeVideoAudio(videoPath, audioPath, outputPath) {
    const cmd = `${ffmpegPath} -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -strict experimental "${outputPath}"`;

    console.log('[FFmpeg] 开始合并:', cmd);

    try {
        await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
        console.log('[FFmpeg] 合并完成:', outputPath);
        return true;
    } catch (err) {
        console.error('[FFmpeg] 合并失败:', err.message);
        throw err;
    }
}

/**
 * 生成登录二维码
 * @returns {Promise<{url: string, qrcode_key: string}>}
 */
async function generateQRCode() {
    const url = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
    const { data } = await request(url);

    if (data.code !== 0) {
        throw new Error(data.message || '生成二维码失败');
    }

    return {
        url: data.data.url,        // 二维码内容 URL
        qrcode_key: data.data.qrcode_key  // 用于轮询的 key
    };
}

/**
 * 轮询二维码扫描状态
 * @param {string} qrcode_key 
 * @returns {Promise<{code: number, message: string, cookie?: string}>}
 * 
 * code 状态：
 * 0 - 登录成功
 * 86101 - 未扫码
 * 86090 - 已扫码未确认
 * 86038 - 二维码已过期
 */
async function pollQRCodeStatus(qrcode_key) {
    const url = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${qrcode_key}`;
    const { data, cookies } = await request(url);

    const result = {
        code: data.data?.code ?? data.code,
        message: data.data?.message || data.message || ''
    };

    // 登录成功，提取 Cookie
    if (result.code === 0 && cookies.length > 0) {
        // 解析并合并所有 cookie
        const cookieParts = cookies.map(c => c.split(';')[0]);
        result.cookie = cookieParts.join('; ');
    }

    return result;
}

/**
 * 检查登录状态
 * @param {string} cookie 
 * @returns {Promise<{isLogin: boolean, username?: string, face?: string}>}
 */
async function checkLoginStatus(cookie) {
    const url = 'https://api.bilibili.com/x/web-interface/nav';
    const { data } = await request(url, {
        headers: { Cookie: cookie }
    });

    if (data.code === 0 && data.data?.isLogin) {
        return {
            isLogin: true,
            username: data.data.uname,
            face: data.data.face,
            mid: data.data.mid,
            vipStatus: data.data.vipStatus
        };
    }

    return { isLogin: false };
}

/**
 * 保存房间的 Cookie
 */
function saveCookie(roomId, cookie) {
    cookieStore.set(roomId, cookie);
}

/**
 * 获取房间的 Cookie
 */
function getCookie(roomId) {
    return cookieStore.get(roomId) || '';
}

/**
 * 删除房间的 Cookie
 */
function deleteCookie(roomId) {
    cookieStore.delete(roomId);
}

/**
 * 从 URL 或字符串中提取 BV 号
 * @param {string} input 
 * @returns {string|null}
 */
function extractBVID(input) {
    if (!input) return null;

    // 匹配 BV 号格式 (BV + 10位字符)
    const match = input.match(/BV[a-zA-Z0-9]{10}/i);
    return match ? match[0] : null;
}

/**
 * 获取视频信息
 * @param {string} bvid BV 号
 * @param {string} cookie 可选 Cookie
 * @returns {Promise<Object>}
 */
async function getVideoInfo(bvid, cookie = '') {
    const url = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
    const { data } = await request(url, {
        headers: cookie ? { Cookie: cookie } : {}
    });

    if (data.code !== 0) {
        throw new Error(data.message || '获取视频信息失败');
    }

    const info = data.data;
    return {
        bvid: info.bvid,
        aid: info.aid,
        title: info.title,
        desc: info.desc,
        pic: info.pic,           // 封面
        duration: info.duration, // 时长(秒)
        owner: {
            mid: info.owner.mid,
            name: info.owner.name,
            face: info.owner.face
        },
        stat: {
            view: info.stat.view,
            danmaku: info.stat.danmaku,
            like: info.stat.like
        },
        // 分P列表
        pages: info.pages.map(p => ({
            cid: p.cid,
            page: p.page,
            part: p.part,           // 分P标题
            duration: p.duration
        })),
        cid: info.cid  // 默认 cid (第一P)
    };
}

/**
 * 获取视频播放地址
 * @param {string} bvid BV 号
 * @param {number} cid 分P的 cid
 * @param {number} qn 清晰度代码
 * @param {string} cookie 可选 Cookie
 * @returns {Promise<Object>}
 */
async function getPlayUrl(bvid, cid, qn = 80, cookie = '') {
    // fnval=16 表示请求 dash 格式
    const url = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${qn}&fnval=16&fourk=1`;

    const { data } = await request(url, {
        headers: cookie ? { Cookie: cookie } : {}
    });

    if (data.code !== 0) {
        throw new Error(data.message || '获取播放地址失败');
    }

    const result = {
        quality: data.data.quality,
        format: data.data.format,
        accept_quality: data.data.accept_quality || [],
        accept_description: data.data.accept_description || [],
        // 构建清晰度选项
        qualities: (data.data.accept_quality || []).map((q, i) => ({
            qn: q,
            description: data.data.accept_description?.[i] || QUALITY_MAP[q] || `${q}P`
        }))
    };

    // DASH 格式
    if (data.data.dash) {
        const dash = data.data.dash;
        // 选择最佳视频流
        const video = dash.video?.[0];
        // 选择最佳音频流
        const audio = dash.audio?.[0];

        result.dash = {
            video: video ? {
                url: video.baseUrl || video.base_url,
                backup_url: video.backupUrl || video.backup_url,
                bandwidth: video.bandwidth,
                codecs: video.codecs,
                width: video.width,
                height: video.height
            } : null,
            audio: audio ? {
                url: audio.baseUrl || audio.base_url,
                backup_url: audio.backupUrl || audio.backup_url,
                bandwidth: audio.bandwidth,
                codecs: audio.codecs
            } : null
        };
    }

    // FLV 格式 (兼容旧版)
    if (data.data.durl) {
        result.durl = data.data.durl.map(d => ({
            url: d.url,
            backup_url: d.backup_url,
            size: d.size,
            length: d.length
        }));
    }

    return result;
}

/**
 * 下载并合并 B 站视频
 * @param {string} bvid BV 号
 * @param {number} cid 分P cid
 * @param {number} qn 清晰度
 * @param {string} cookie Cookie
 * @param {string} uploadsDir 上传目录
 * @param {function} onProgress 进度回调
 * @returns {Promise<string>} 输出文件路径
 */
async function downloadAndMerge(bvid, cid, qn, cookie, uploadsDir, onProgress = () => { }) {
    const taskId = `${bvid}_${cid}_${qn}_${Date.now()}`;
    const videoPath = path.join(uploadsDir, `${taskId}_video.m4s`);
    const audioPath = path.join(uploadsDir, `${taskId}_audio.m4s`);
    const outputPath = path.join(uploadsDir, `bilibili_${taskId}.mp4`);

    try {
        onProgress({ stage: 'fetching', progress: 5, message: '获取播放地址...' });

        // 获取播放地址
        const playUrl = await getPlayUrl(bvid, cid, qn, cookie);

        if (!playUrl.dash?.video || !playUrl.dash?.audio) {
            throw new Error('无法获取 DASH 格式视频');
        }

        const videoUrl = playUrl.dash.video.url;
        const audioUrl = playUrl.dash.audio.url;

        onProgress({ stage: 'downloading_video', progress: 10, message: '下载视频流...' });

        // 格式化文件大小
        const formatSize = (bytes) => {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        };

        // 下载视频流，带进度回调
        await downloadFile(videoUrl, videoPath, cookie, 3, (p) => {
            const progress = 10 + Math.round(p.percent * 0.35); // 10% - 45%
            onProgress({
                stage: 'downloading_video',
                progress,
                message: `下载视频流 ${formatSize(p.downloaded)} / ${formatSize(p.total)}`
            });
        });

        onProgress({ stage: 'downloading_audio', progress: 50, message: '下载音频流...' });

        // 下载音频流，带进度回调
        await downloadFile(audioUrl, audioPath, cookie, 3, (p) => {
            const progress = 50 + Math.round(p.percent * 0.2); // 50% - 70%
            onProgress({
                stage: 'downloading_audio',
                progress,
                message: `下载音频流 ${formatSize(p.downloaded)} / ${formatSize(p.total)}`
            });
        });

        onProgress({ stage: 'merging', progress: 70, message: '合并音视频...' });

        // 使用 FFmpeg 合并
        await mergeVideoAudio(videoPath, audioPath, outputPath);

        onProgress({ stage: 'complete', progress: 100, message: '处理完成' });

        // 清理临时文件
        fs.unlink(videoPath, () => { });
        fs.unlink(audioPath, () => { });

        return outputPath;

    } catch (err) {
        // 清理临时文件
        fs.unlink(videoPath, () => { });
        fs.unlink(audioPath, () => { });
        fs.unlink(outputPath, () => { });
        throw err;
    }
}

/**
 * 代理请求 B 站视频流 (保留用于备用)
 * @param {string} videoUrl 视频 URL
 * @param {Object} req Express request
 * @param {Object} res Express response
 * @param {string} cookie 可选 Cookie
 */
function proxyVideoStream(videoUrl, req, res, cookie = '') {
    const urlObj = new URL(videoUrl);

    const headers = {
        ...DEFAULT_HEADERS,
        'Host': urlObj.host
    };

    if (cookie) {
        headers['Cookie'] = cookie;
    }

    // 转发 Range 请求头
    if (req.headers.range) {
        headers['Range'] = req.headers.range;
    }

    const protocol = urlObj.protocol === 'https:' ? https : http;

    const proxyReq = protocol.request({
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers
    }, (proxyRes) => {
        // 转发响应头
        res.status(proxyRes.statusCode);

        const forwardHeaders = [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges'
        ];

        forwardHeaders.forEach(h => {
            if (proxyRes.headers[h]) {
                res.setHeader(h, proxyRes.headers[h]);
            }
        });

        // 允许跨域
        res.setHeader('Access-Control-Allow-Origin', '*');

        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error('代理请求错误:', err);
        res.status(500).json({ error: '视频流代理失败' });
    });

    proxyReq.end();
}

/**
 * 只下载不合并 (用于 MSE 播放)
 * @param {string} bvid BV 号
 * @param {number} cid 分P cid
 * @param {number} qn 清晰度
 * @param {string} cookie Cookie
 * @param {string} uploadsDir 上传目录
 * @param {function} onProgress 进度回调
 * @returns {Promise<{videoPath: string, audioPath: string, codecs: object}>}
 */
async function downloadSeparate(bvid, cid, qn, cookie, uploadsDir, onProgress = () => { }) {
    const taskId = `${bvid}_${cid}_${qn}_${Date.now()}`;
    const videoFilename = `bilibili_${taskId}_video.m4s`;
    const audioFilename = `bilibili_${taskId}_audio.m4s`;
    const videoPath = path.join(uploadsDir, videoFilename);
    const audioPath = path.join(uploadsDir, audioFilename);

    try {
        onProgress({ stage: 'fetching', progress: 5, message: '获取播放地址...' });

        // 获取播放地址
        const playUrl = await getPlayUrl(bvid, cid, qn, cookie);

        if (!playUrl.dash?.video || !playUrl.dash?.audio) {
            throw new Error('无法获取 DASH 格式视频');
        }

        const videoUrl = playUrl.dash.video.url;
        const audioUrl = playUrl.dash.audio.url;

        // 保存编码信息
        const codecs = {
            video: playUrl.dash.video.codecs || 'avc1.64001F',
            audio: playUrl.dash.audio.codecs || 'mp4a.40.2'
        };

        onProgress({ stage: 'downloading_video', progress: 10, message: '下载视频流...' });

        // 格式化文件大小
        const formatSize = (bytes) => {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        };

        // 下载视频流
        await downloadFile(videoUrl, videoPath, cookie, 3, (p) => {
            const progress = 10 + Math.round(p.percent * 0.4); // 10% - 50%
            onProgress({
                stage: 'downloading_video',
                progress,
                message: `下载视频流 ${formatSize(p.downloaded)} / ${formatSize(p.total)}`
            });
        });

        onProgress({ stage: 'downloading_audio', progress: 55, message: '下载音频流...' });

        // 下载音频流
        await downloadFile(audioUrl, audioPath, cookie, 3, (p) => {
            const progress = 55 + Math.round(p.percent * 0.4); // 55% - 95%
            onProgress({
                stage: 'downloading_audio',
                progress,
                message: `下载音频流 ${formatSize(p.downloaded)} / ${formatSize(p.total)}`
            });
        });

        onProgress({ stage: 'complete', progress: 100, message: '下载完成' });

        return {
            videoPath: `/uploads/${videoFilename}`,
            audioPath: `/uploads/${audioFilename}`,
            videoFilename,
            audioFilename,
            codecs
        };

    } catch (err) {
        // 清理临时文件
        fs.unlink(videoPath, () => { });
        fs.unlink(audioPath, () => { });
        throw err;
    }
}

module.exports = {
    QUALITY_MAP,
    generateQRCode,
    pollQRCodeStatus,
    checkLoginStatus,
    saveCookie,
    getCookie,
    deleteCookie,
    extractBVID,
    getVideoInfo,
    getPlayUrl,
    downloadAndMerge,
    downloadSeparate,
    proxyVideoStream
};

