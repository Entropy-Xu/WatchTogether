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

// 创建房间
createForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const userName = document.getElementById('create-username').value.trim();

    if (!userName) {
        showToast('请输入昵称', 'error');
        return;
    }

    // 禁用按钮防止重复提交
    const submitBtn = createForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.querySelector('.btn-text').textContent = '创建中...';

    socket.emit('create-room', { userName }, (response) => {
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

// 加入房间
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

    // 先检查房间是否存在
    fetch(`/api/room/${roomId}`)
        .then(res => res.json())
        .then(data => {
            if (!data.exists) {
                showToast('房间不存在，请检查房间号', 'error');
                return;
            }

            // 保存用户信息
            sessionStorage.setItem('userName', userName);
            sessionStorage.setItem('roomId', roomId);
            sessionStorage.setItem('isHost', 'false');

            // 跳转到房间页面
            window.location.href = `/room.html?id=${roomId}`;
        })
        .catch(() => {
            showToast('网络错误，请重试', 'error');
        });
});

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

console.log('🎬 在线电影放映室已加载');
