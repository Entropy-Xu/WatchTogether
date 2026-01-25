/**
 * 在线电影放映室 - 首页逻辑
 */

// 工具函数：显示 Toast 提示
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;

    setTimeout(() => {
        toast.className = 'toast';
    }, 3000);
}

// Socket.io 连接
const socket = io();

// DOM 元素
const createForm = document.getElementById('create-form');
const joinForm = document.getElementById('join-form');

// ==========================================
// 创建房间
// ==========================================
createForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const userName = document.getElementById('create-username').value.trim();
    const roomName = document.getElementById('room-name').value.trim();
    const password = document.getElementById('room-password').value;

    if (!userName) {
        showToast('请输入昵称', 'error');
        return;
    }

    // 禁用按钮防止重复提交
    const submitBtn = createForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.querySelector('.btn-text').textContent = '创建中...';

    socket.emit('create-room', { userName, roomName, password }, (response) => {
        if (response.success) {
            // 保存用户信息到 sessionStorage
            sessionStorage.setItem('userName', userName);
            sessionStorage.setItem('roomId', response.roomId);
            sessionStorage.setItem('isHost', 'true');

            // 跳转到房间页面
            window.location.href = `/room.html?id=${response.roomId}`;
        } else {
            showToast(response.error || '创建房间失败', 'error');
            submitBtn.disabled = false;
            submitBtn.querySelector('.btn-text').textContent = '创建放映室';
        }
    });
});

// 密码显示切换
document.querySelector('.toggle-password')?.addEventListener('click', function () {
    const input = document.getElementById('room-password');
    const icon = this.querySelector('i');

    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
    }
});

// ==========================================
// 加入房间
// ==========================================
joinForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const userName = document.getElementById('join-username').value.trim();
    const roomId = document.getElementById('room-id').value.trim().toUpperCase();

    if (!userName) {
        showToast('请输入昵称', 'error');
        return;
    }

    if (!roomId || roomId.length < 4) {
        showToast('请输入有效的房间号', 'error');
        return;
    }

    attemptJoinRoom(roomId, userName);
});

// 尝试加入房间
function attemptJoinRoom(roomId, userName, password = null) {
    // 先检查房间是否存在
    fetch(`/api/room/${roomId}`)
        .then(res => res.json())
        .then(data => {
            if (!data.exists) {
                showToast('房间不存在，请检查房间号', 'error');
                return;
            }

            // 如果房间有密码且没提供密码，显示加入房间弹窗
            if (data.hasPassword && !password) {
                showJoinModal(roomId, data.name || `房间 ${roomId}`, true);
                // 预填昵称
                setTimeout(() => {
                    const usernameInput = document.getElementById('join-modal-username');
                    if (usernameInput && !usernameInput.value) {
                        usernameInput.value = userName;
                    }
                }, 100);
                return;
            }

            // 保存用户信息
            sessionStorage.setItem('userName', userName);
            sessionStorage.setItem('roomId', roomId);
            sessionStorage.setItem('isHost', 'false');
            if (password) {
                sessionStorage.setItem('roomPassword', password);
            }

            // 跳转到房间页面
            window.location.href = `/room.html?id=${roomId}`;
        })
        .catch(() => {
            showToast('网络错误，请重试', 'error');
        });
}

// ==========================================
// 加入房间弹窗
// ==========================================
let pendingJoinRoomData = null;  // { roomId, roomName, hasPassword }

function showJoinModal(roomId, roomName, hasPassword) {
    pendingJoinRoomData = { roomId, roomName, hasPassword };

    const modal = document.getElementById('join-modal');
    const roomNameEl = document.getElementById('join-modal-room-name');
    const usernameInput = document.getElementById('join-modal-username');
    const passwordGroup = document.getElementById('join-modal-password-group');
    const passwordInput = document.getElementById('join-modal-password');
    const errorEl = document.getElementById('join-modal-error');
    const titleIcon = modal.querySelector('.modal-header h3 i');

    roomNameEl.textContent = `加入「${roomName}」`;
    usernameInput.value = document.getElementById('join-username')?.value.trim() ||
        document.getElementById('create-username')?.value.trim() || '';
    passwordInput.value = '';
    errorEl.textContent = '';

    // 根据是否需要密码显示/隐藏密码输入框
    if (hasPassword) {
        passwordGroup.style.display = 'block';
        titleIcon.className = 'fa-solid fa-lock';
    } else {
        passwordGroup.style.display = 'none';
        titleIcon.className = 'fa-solid fa-door-open';
    }

    modal.classList.add('show');
    setTimeout(() => usernameInput.focus(), 100);
}

function hideJoinModal() {
    const modal = document.getElementById('join-modal');
    modal.classList.remove('show');
    pendingJoinRoomData = null;
}

// 加入房间弹窗事件
document.getElementById('join-modal-close')?.addEventListener('click', hideJoinModal);
document.getElementById('join-modal-cancel')?.addEventListener('click', hideJoinModal);

document.getElementById('join-modal-confirm')?.addEventListener('click', () => {
    if (!pendingJoinRoomData) return;

    const username = document.getElementById('join-modal-username').value.trim();
    const password = document.getElementById('join-modal-password').value;
    const errorEl = document.getElementById('join-modal-error');

    if (!username) {
        errorEl.textContent = '请输入昵称';
        return;
    }

    if (pendingJoinRoomData.hasPassword && !password) {
        errorEl.textContent = '请输入房间密码';
        return;
    }

    // 保存信息并跳转
    const roomId = pendingJoinRoomData.roomId; // 先保存 roomId，因为 hideJoinModal 会清空 pendingJoinRoomData
    sessionStorage.setItem('userName', username);
    sessionStorage.setItem('roomId', roomId);
    sessionStorage.setItem('isHost', 'false');
    if (password) {
        sessionStorage.setItem('roomPassword', password);
    }

    hideJoinModal();
    window.location.href = `/room.html?id=${roomId}`;
});

// 回车键确认
document.getElementById('join-modal-username')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const passwordGroup = document.getElementById('join-modal-password-group');
        if (passwordGroup.style.display !== 'none') {
            document.getElementById('join-modal-password').focus();
        } else {
            document.getElementById('join-modal-confirm')?.click();
        }
    }
});

document.getElementById('join-modal-password')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        document.getElementById('join-modal-confirm')?.click();
    }
});

// 点击模态框外部关闭
document.getElementById('join-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'join-modal') {
        hideJoinModal();
    }
});

// ==========================================
// 大厅 - 房间列表
// ==========================================
function loadRoomList() {
    const roomList = document.getElementById('room-list');
    roomList.innerHTML = '<div class="room-list-loading"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>';

    fetch('/api/rooms')
        .then(res => res.json())
        .then(data => {
            if (!data.success || data.rooms.length === 0) {
                roomList.innerHTML = '<div class="room-list-empty"><i class="fa-solid fa-couch"></i><p>暂无公开放映室</p><span>创建一个放映室，邀请朋友一起观看吧！</span></div>';
                return;
            }

            roomList.innerHTML = '';
            data.rooms.forEach(room => {
                const card = createRoomCard(room);
                roomList.appendChild(card);
            });
        })
        .catch(() => {
            roomList.innerHTML = '<div class="room-list-empty"><i class="fa-solid fa-exclamation-triangle"></i><p>加载失败</p><span>请检查网络连接后重试</span></div>';
        });
}

function createRoomCard(room) {
    const card = document.createElement('div');
    card.className = 'room-card';

    const timeAgo = formatTimeAgo(room.createdAt);

    card.innerHTML = `
        <div class="room-card-header">
            <span class="room-name">${escapeHtml(room.name)}</span>
            ${room.hasPassword ? '<i class="fa-solid fa-lock room-lock" title="需要密码"></i>' : ''}
        </div>
        <div class="room-card-info">
            <span class="room-host"><i class="fa-solid fa-user"></i> ${escapeHtml(room.hostName)}</span>
            <span class="room-users"><i class="fa-solid fa-users"></i> ${room.userCount}人</span>
            <span class="room-time"><i class="fa-regular fa-clock"></i> ${timeAgo}</span>
        </div>
        <button class="btn btn-join" data-room-id="${room.id}">
            ${room.hasPassword ? '<i class="fa-solid fa-key"></i>' : '<i class="fa-solid fa-door-open"></i>'}
            <span>加入</span>
        </button>
    `;

    // 加入按钮事件 - 打开加入房间弹窗
    card.querySelector('.btn-join').addEventListener('click', () => {
        showJoinModal(room.id, room.name, room.hasPassword);
    });

    return card;
}

function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return '刚刚';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`;
    return `${Math.floor(seconds / 86400)}天前`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 刷新按钮
document.getElementById('refresh-rooms-btn')?.addEventListener('click', function () {
    const icon = this.querySelector('i');
    icon.classList.add('fa-spin');

    loadRoomList();

    setTimeout(() => {
        icon.classList.remove('fa-spin');
    }, 500);
});

// ==========================================
// 初始化
// ==========================================

// 房间号自动转大写
document.getElementById('room-id').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
});

// 从 URL 参数预填房间号（用于分享链接）
const urlParams = new URLSearchParams(window.location.search);
const roomIdFromUrl = urlParams.get('join');
if (roomIdFromUrl) {
    document.getElementById('room-id').value = roomIdFromUrl.toUpperCase();
    document.getElementById('join-username').focus();
}

// 页面加载时获取房间列表
loadRoomList();

console.log('🎬 在线电影放映室已加载');
