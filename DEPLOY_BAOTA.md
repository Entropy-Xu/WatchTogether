# 宝塔面板 (Baota Panel) 部署指南

本指南将帮助你在宝塔面板上部署 Online Media Player。

## 前置准备 (Prerequisites)

在宝塔面板的【软件商店】中安装以下软件：
1.  **Nginx** (用于反向代理和静态服务)
2.  **Node.js 版本管理器** (用于运行服务)
    -   安装后，请在设置中选择并安装 **Node.js v16** 或更高版本（推荐 v18/v20）。
    -   设置好 `registry` 源（可选淘宝源）。
3.  **PM2 管理器** (可选，如果使用"Node项目"功能则不需要单独配置，但建议安装以便查看进程)。

## 关键步骤：安装 FFmpeg (重要)

由于我们的项目启用了视频自动优化功能，服务器**必须**安装 FFmpeg。

1.  登录宝塔面板，点击左侧菜单的【终端】。
2.  输入 `root` 密码登录终端。
3.  根据你的服务器系统执行安装命令：

    **CentOS:**
    ```bash
    # 安装 EPEL 源 (如果没有)
    yum install epel-release -y
    # 尝试直接安装
    yum install ffmpeg -y
    
    # 如果yum安装失败，建议使用 snap 安装 (CentOS 7+)
    yum install snapd -y
    systemctl enable --now snapd.socket
    ln -s /var/lib/snapd/snap /snap
    snap install ffmpeg
    ```

    **Ubuntu/Debian:**
    ```bash
    sudo apt update
    sudo apt install ffmpeg -y
    ```
4.  验证安装：
    ```bash
    ffmpeg -version
    ```
    如果能看到版本号说明安装成功。

## 部署步骤

### 1. 上传文件
1.  进入【文件】，进入 `/www/wwwroot/` 目录。
2.  新建文件夹，例如 `movie-room`。
3.  将本地项目文件打包上传并解压（除 `node_modules` 以外的所有文件）。
    -   确保 `server.js`, `package.json`, `public/` 都在根目录下。
    -   确保存在 `uploads/` 目录（如果没有请新建）。

### 2. 添加 Node 项目
1.  点击左侧菜单【网站】 -> 【Node项目】 -> 【添加Node项目】。
2.  **项目目录**: 选择刚才创建的 `/www/wwwroot/movie-room`。
3.  **启动选项**: `start` (对应 package.json 中的 npm start)。
4.  **项目端口**: `3000` (默认)。
5.  **Node版本**: 选择已安装的版本 (v16+)。
6.  **绑定域名**: 输入你的域名或 IP 地址。
7.  点击【提交】。等待依赖安装完成。

### 3. 配置 Nginx 反向代理 (WebSocket 支持)

socket.io 需要 WebSocket 支持，必须修改 Nginx 配置。

1.  在【Node项目】列表中，找到你的项目，点击【设置】。
2.  点击【配置文件】（或者如果使用了单独的 Nginx 反向代理，请在 Nginx 代理配置中修改）。
3.  确保配置中包含以下 WebSocket 升级头信息（通常在 `location /` 块中）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-NginX-Proxy true;
    
    # 增加上传文件大小限制 (如果不修改，上传大视频会报错 413)
    client_max_body_size 1024M;
}
```

> **注意**: 如果你没有绑定域名直接用 IP:3000 访问，还需要确保宝塔面板【安全】中放行了 3000 端口。但建议通过 Nginx 80/443 端口转发。

### 4. 常见问题
-   **上传失败 (413 Request Entity Too Large)**:
    -   检查 Nginx 配置中的 `client_max_body_size` 是否设置得足够大（如 1024M）。
    -   检查 Node 项目日志是否有报错。
-   **视频无法播放/一直显示转换中**:
    -   检查服务器是否安装了 `ffmpeg`。
    -   查看【项目日志】是否有 ffmpeg 相关的报错信息。
-   **无法连接到服务器**:
    -   检查 Socket.io 连接是否正常（F12 查看 Network 中的 ws 请求）。
    -   检查防火墙端口是否开放。

## 完成
现在你应该可以通过域名或 IP 访问你的在线放映室了！
