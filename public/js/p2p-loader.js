/**
 * P2P 视频片段加载器
 * 复用 WebRTC DataChannel 实现同房间用户间的视频片段共享
 */

class P2PLoader {
    constructor(socket, roomId, rtcConfig) {
        this.socket = socket;
        this.roomId = roomId;
        this.rtcConfig = rtcConfig;

        // P2P 连接管理
        this.peers = new Map();           // peerId -> { pc, dataChannel, ready }
        this.pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }

        // 本地缓存
        this.segmentCache = new Map();    // segmentUrl -> { data, timestamp }
        this.cacheMaxSize = 50;           // 最多缓存 50 个片段
        this.cacheMaxAge = 5 * 60 * 1000; // 缓存 5 分钟

        // 统计
        this.stats = {
            p2pDownloaded: 0,
            httpDownloaded: 0,
            p2pUploaded: 0
        };

        // 是否启用 P2P
        this.enabled = true;

        // 绑定 socket 事件
        this._bindSocketEvents();

        console.log('[P2P] 加载器初始化完成');
    }

    /**
     * 绑定 Socket.IO 信令事件
     */
    _bindSocketEvents() {
        // 收到其他用户加入 P2P 网络
        this.socket.on('p2p-peer-joined', ({ peerId, peerName }) => {
            console.log(`[P2P] 用户 ${peerName} 加入 P2P 网络`);
            this._createPeerConnection(peerId, true);
        });

        // 收到 P2P offer
        this.socket.on('p2p-offer', async ({ fromId, offer }) => {
            console.log(`[P2P] 收到来自 ${fromId} 的 offer`);
            await this._handleOffer(fromId, offer);
        });

        // 收到 P2P answer
        this.socket.on('p2p-answer', async ({ fromId, answer }) => {
            console.log(`[P2P] 收到来自 ${fromId} 的 answer`);
            await this._handleAnswer(fromId, answer);
        });

        // 收到 ICE candidate
        this.socket.on('p2p-ice', async ({ fromId, candidate }) => {
            await this._handleIceCandidate(fromId, candidate);
        });

        // 用户离开
        this.socket.on('p2p-peer-left', ({ peerId }) => {
            this._closePeerConnection(peerId);
        });
    }

    /**
     * 加入 P2P 网络
     */
    join() {
        this.socket.emit('p2p-join', { roomId: this.roomId });
        console.log('[P2P] 已加入 P2P 网络');
    }

    /**
     * 离开 P2P 网络
     */
    leave() {
        this.socket.emit('p2p-leave');
        this.peers.forEach((_, peerId) => this._closePeerConnection(peerId));
        this.peers.clear();
        console.log('[P2P] 已离开 P2P 网络');
    }

    /**
     * 创建与指定用户的 P2P 连接
     */
    async _createPeerConnection(peerId, isInitiator) {
        if (this.peers.has(peerId)) return;

        const pc = new RTCPeerConnection(this.rtcConfig);
        const peerInfo = { pc, dataChannel: null, ready: false };
        this.peers.set(peerId, peerInfo);

        // ICE candidate 处理
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('p2p-ice', {
                    targetId: peerId,
                    candidate: event.candidate
                });
            }
        };

        pc.onconnectionstatechange = () => {
            console.log(`[P2P] 与 ${peerId} 连接状态: ${pc.connectionState}`);
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                this._closePeerConnection(peerId);
            }
        };

        if (isInitiator) {
            // 创建 DataChannel
            const dc = pc.createDataChannel('p2p-segments', {
                ordered: false,  // 无序传输，提高速度
                maxRetransmits: 2
            });
            this._setupDataChannel(dc, peerId);
            peerInfo.dataChannel = dc;

            // 创建并发送 offer（等待 ICE 收集后再发送）
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                await this._waitForIceGathering(pc);
                this.socket.emit('p2p-offer', {
                    targetId: peerId,
                    offer: pc.localDescription
                });
            } catch (err) {
                console.error('[P2P] 创建 offer 失败:', err);
            }
        } else {
            // 等待接收 DataChannel
            pc.ondatachannel = (event) => {
                this._setupDataChannel(event.channel, peerId);
                peerInfo.dataChannel = event.channel;
            };
        }
    }

    /**
     * 配置 DataChannel
     */
    _setupDataChannel(dc, peerId) {
        dc.binaryType = 'arraybuffer';

        dc.onopen = () => {
            console.log(`[P2P] DataChannel 与 ${peerId} 已打开`);
            const peerInfo = this.peers.get(peerId);
            if (peerInfo) peerInfo.ready = true;
        };

        dc.onclose = () => {
            console.log(`[P2P] DataChannel 与 ${peerId} 已关闭`);
            const peerInfo = this.peers.get(peerId);
            if (peerInfo) peerInfo.ready = false;
        };

        dc.onmessage = (event) => {
            this._handleMessage(peerId, event.data);
        };

        dc.onerror = (err) => {
            console.error(`[P2P] DataChannel 错误:`, err);
        };
    }

    /**
     * 等待 ICE 收集完成或超时
     */
    _waitForIceGathering(pc, timeout = 2000) {
        return new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') {
                resolve();
                return;
            }
            let resolved = false;
            const done = () => {
                if (resolved) return;
                resolved = true;
                resolve();
            };
            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete') done();
            };
            setTimeout(done, timeout);
        });
    }

    /**
     * 处理收到的 offer
     */
    async _handleOffer(fromId, offer) {
        await this._createPeerConnection(fromId, false);
        const peerInfo = this.peers.get(fromId);
        if (!peerInfo) return;

        try {
            await peerInfo.pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await peerInfo.pc.createAnswer();
            await peerInfo.pc.setLocalDescription(answer);
            await this._waitForIceGathering(peerInfo.pc);

            this.socket.emit('p2p-answer', {
                targetId: fromId,
                answer: peerInfo.pc.localDescription
            });
        } catch (err) {
            console.error('[P2P] 处理 offer 失败:', err);
        }
    }

    /**
     * 处理收到的 answer
     */
    async _handleAnswer(fromId, answer) {
        const peerInfo = this.peers.get(fromId);
        if (!peerInfo) return;

        try {
            await peerInfo.pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (err) {
            console.error('[P2P] 处理 answer 失败:', err);
        }
    }

    /**
     * 处理 ICE candidate
     */
    async _handleIceCandidate(fromId, candidate) {
        const peerInfo = this.peers.get(fromId);
        if (!peerInfo) return;

        try {
            await peerInfo.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.error('[P2P] 添加 ICE candidate 失败:', err);
        }
    }

    /**
     * 关闭 P2P 连接
     */
    _closePeerConnection(peerId) {
        const peerInfo = this.peers.get(peerId);
        if (peerInfo) {
            if (peerInfo.dataChannel) {
                peerInfo.dataChannel.close();
            }
            peerInfo.pc.close();
            this.peers.delete(peerId);
        }
    }

    /**
     * 处理收到的消息
     */
    _handleMessage(peerId, data) {
        try {
            // 如果是字符串，解析为 JSON
            if (typeof data === 'string') {
                const msg = JSON.parse(data);

                if (msg.type === 'request') {
                    // 收到片段请求
                    this._handleSegmentRequest(peerId, msg);
                } else if (msg.type === 'response') {
                    // 收到片段响应（元数据）
                    this._handleSegmentResponse(msg);
                } else if (msg.type === 'not-found') {
                    // 对方没有该片段
                    this._handleNotFound(msg);
                }
            } else {
                // 二进制数据 - 片段数据
                this._handleSegmentData(data);
            }
        } catch (err) {
            console.error('[P2P] 消息处理错误:', err);
        }
    }

    /**
     * 处理片段请求
     */
    _handleSegmentRequest(peerId, msg) {
        const cached = this.segmentCache.get(msg.url);
        const peerInfo = this.peers.get(peerId);

        if (cached && peerInfo && peerInfo.ready) {
            // 发送响应元数据
            peerInfo.dataChannel.send(JSON.stringify({
                type: 'response',
                requestId: msg.requestId,
                url: msg.url,
                size: cached.data.byteLength
            }));

            // 发送数据（带 requestId 前缀）
            const header = new TextEncoder().encode(msg.requestId + '|');
            const combined = new Uint8Array(header.length + cached.data.byteLength);
            combined.set(header, 0);
            combined.set(new Uint8Array(cached.data), header.length);

            peerInfo.dataChannel.send(combined.buffer);
            this.stats.p2pUploaded += cached.data.byteLength;

            console.log(`[P2P] 向 ${peerId} 发送片段: ${msg.url.substring(0, 50)}...`);
        } else {
            // 没有缓存，告知对方
            if (peerInfo && peerInfo.ready) {
                peerInfo.dataChannel.send(JSON.stringify({
                    type: 'not-found',
                    requestId: msg.requestId
                }));
            }
        }
    }

    /**
     * 处理片段响应
     */
    _handleSegmentResponse(msg) {
        // 响应会在 _handleSegmentData 中处理实际数据
        console.log(`[P2P] 收到片段响应: ${msg.url.substring(0, 50)}..., 大小: ${msg.size}`);
    }

    /**
     * 处理片段数据
     */
    _handleSegmentData(data) {
        const uint8 = new Uint8Array(data);

        // 查找分隔符位置
        const separatorIndex = uint8.indexOf('|'.charCodeAt(0));
        if (separatorIndex === -1) return;

        // 提取 requestId
        const requestId = new TextDecoder().decode(uint8.slice(0, separatorIndex));
        const segmentData = uint8.slice(separatorIndex + 1).buffer;

        // 查找并完成 pending request
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(requestId);
            this.stats.p2pDownloaded += segmentData.byteLength;
            pending.resolve(segmentData);
            console.log(`[P2P] 收到片段数据, requestId: ${requestId}, 大小: ${segmentData.byteLength}`);
        }
    }

    /**
     * 处理 not-found 响应
     */
    _handleNotFound(msg) {
        // 触发下一个 peer 或 HTTP fallback
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending && pending.tryNextPeer) {
            pending.tryNextPeer();
        }
    }

    /**
     * 尝试从 P2P 网络获取片段
     * @returns {Promise<ArrayBuffer|null>} 返回片段数据，如果 P2P 获取失败返回 null
     */
    async getSegment(url) {
        if (!this.enabled) return null;

        // 先检查本地缓存
        const cached = this.segmentCache.get(url);
        if (cached && Date.now() - cached.timestamp < this.cacheMaxAge) {
            return cached.data;
        }

        // 获取可用的 peers
        const availablePeers = Array.from(this.peers.entries())
            .filter(([_, info]) => info.ready)
            .map(([id, _]) => id);

        if (availablePeers.length === 0) return null;

        // 生成请求 ID
        const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        return new Promise((resolve) => {
            let peerIndex = 0;

            const tryNextPeer = () => {
                if (peerIndex >= availablePeers.length) {
                    // 所有 peer 都尝试过了
                    this.pendingRequests.delete(requestId);
                    resolve(null);
                    return;
                }

                const peerId = availablePeers[peerIndex++];
                const peerInfo = this.peers.get(peerId);

                if (!peerInfo || !peerInfo.ready) {
                    tryNextPeer();
                    return;
                }

                // 发送请求
                peerInfo.dataChannel.send(JSON.stringify({
                    type: 'request',
                    requestId,
                    url
                }));
            };

            // 设置超时
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                resolve(null);
            }, 3000); // 3 秒超时

            this.pendingRequests.set(requestId, {
                resolve: (data) => {
                    // 缓存数据
                    this.addToCache(url, data);
                    resolve(data);
                },
                reject: () => resolve(null),
                timeout,
                tryNextPeer
            });

            // 开始尝试
            tryNextPeer();
        });
    }

    /**
     * 添加片段到缓存
     */
    addToCache(url, data) {
        // 清理过期缓存
        this._cleanCache();

        // 如果缓存已满，删除最旧的
        if (this.segmentCache.size >= this.cacheMaxSize) {
            const oldest = Array.from(this.segmentCache.entries())
                .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
            if (oldest) {
                this.segmentCache.delete(oldest[0]);
            }
        }

        this.segmentCache.set(url, {
            data: data instanceof ArrayBuffer ? data : data.buffer || data,
            timestamp: Date.now()
        });
    }

    /**
     * 清理过期缓存
     */
    _cleanCache() {
        const now = Date.now();
        for (const [url, info] of this.segmentCache.entries()) {
            if (now - info.timestamp > this.cacheMaxAge) {
                this.segmentCache.delete(url);
            }
        }
    }

    /**
     * 获取统计信息
     */
    getStats() {
        const total = this.stats.p2pDownloaded + this.stats.httpDownloaded;
        return {
            ...this.stats,
            p2pRatio: total > 0 ? (this.stats.p2pDownloaded / total * 100).toFixed(1) : 0,
            connectedPeers: Array.from(this.peers.values()).filter(p => p.ready).length,
            cachedSegments: this.segmentCache.size
        };
    }

    /**
     * 重置统计
     */
    resetStats() {
        this.stats = {
            p2pDownloaded: 0,
            httpDownloaded: 0,
            p2pUploaded: 0
        };
    }

    /**
     * 启用/禁用 P2P
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        console.log(`[P2P] ${enabled ? '已启用' : '已禁用'}`);
    }
}

// 导出
window.P2PLoader = P2PLoader;
