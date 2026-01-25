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

// 密码弹窗相关状态
let pendingJoinRoom = null;  // { roomId, userName }

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

            // 如果房间有密码且没提供密码，显示密码弹窗
            if (data.hasPassword && !password) {
                pendingJoinRoom = { roomId, userName };
                showPasswordModal(data.name || `房间 ${roomId}`);
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
// 密码弹窗
// ==========================================
function showPasswordModal(roomName) {
    const modal = document.getElementById('password-modal');
    const roomNameEl = document.getElementById('password-room-name');
    const passwordInput = document.getElementById('join-password');
    const errorEl = document.getElementById('password-error');

    roomNameEl.textContent = `加入「${roomName}」`;
    passwordInput.value = '';
    errorEl.textContent = '';
    modal.classList.add('show');

    setTimeout(() => passwordInput.focus(), 100);
}

function hidePasswordModal() {
    const modal = document.getElementById('password-modal');
    modal.classList.remove('show');
    pendingJoinRoom = null;
}

// 密码弹窗事件
document.getElementById('password-modal-close')?.addEventListener('click', hidePasswordModal);
document.getElementById('password-cancel-btn')?.addEventListener('click', hidePasswordModal);

document.getElementById('password-confirm-btn')?.addEventListener('click', () => {
    if (!pendingJoinRoom) return;

    const password = document.getElementById('join-password').value;
    if (!password) {
        document.getElementById('password-error').textContent = '请输入密码';
        return;
    }

    hidePasswordModal();
    sessionStorage.setItem('roomPassword', password);
    sessionStorage.setItem('userName', pendingJoinRoom.userName);
    sessionStorage.setItem('roomId', pendingJoinRoom.roomId);
    sessionStorage.setItem('isHost', 'false');

    window.location.href = `/room.html?id=${pendingJoinRoom.roomId}`;
});

document.getElementById('join-password')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        document.getElementById('password-confirm-btn')?.click();
    }
});

// 点击模态框外部关闭
document.getElementById('password-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'password-modal') {
        hidePasswordModal();
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

    // 加入按钮事件
    card.querySelector('.btn-join').addEventListener('click', () => {
        const userName = document.getElementById('join-username').value.trim() ||
            document.getElementById('create-username').value.trim();

        if (!userName) {
            showToast('请先在上方输入你的昵称', 'error');
            document.getElementById('join-username').focus();
            return;
        }

        attemptJoinRoom(room.id, userName);
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
