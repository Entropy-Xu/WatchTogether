/**
 * 通用影视站解析器
 * 用于解析 yt-dlp 不支持的影视聚合网站
 */

const https = require('https');
const http = require('http');

/**
 * 从网页中提取 m3u8/mp4 地址
 * 支持多种常见的加密/混淆方式
 */
async function extractVideoUrl(pageUrl) {
  const html = await fetchPage(pageUrl);
  
  // 尝试多种提取模式
  const extractors = [
    extractPlayerAaaa,      // player_aaaa 格式 (苹果CMS)
    extractPlayerConfig,    // player_config 格式
    extractIframeSrc,       // iframe 嵌套
    extractDirectUrl,       // 直接 m3u8/mp4 链接
    extractJsonPlayer,      // JSON 播放器配置
  ];

  for (const extractor of extractors) {
    try {
      const result = await extractor(html, pageUrl);
      if (result && result.url) {
        console.log(`[通用解析] 成功提取: ${extractor.name}`);
        return result;
      }
    } catch (err) {
      // 继续尝试下一个提取器
    }
  }

  throw new Error('无法从该网页提取视频地址，可能不支持此网站');
}

/**
 * 获取网页内容
 */
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': urlObj.origin
      },
      timeout: 15000
    };

    const req = protocol.request(options, (res) => {
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchPage(redirectUrl).then(resolve).catch(reject);
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });

    req.end();
  });
}

/**
 * 解码 URL (支持 Base64 + URL编码)
 */
function decodeUrl(encoded) {
  if (!encoded) return null;
  
  try {
    // 尝试 Base64 解码
    let decoded = Buffer.from(encoded, 'base64').toString('utf8');
    
    // 检查是否是 URL 编码
    if (decoded.includes('%')) {
      decoded = decodeURIComponent(decoded);
    }
    
    // 验证是否是有效 URL
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
      return decoded;
    }
    
    // 如果不是 Base64，尝试直接 URL 解码
    const directDecode = decodeURIComponent(encoded);
    if (directDecode.startsWith('http://') || directDecode.startsWith('https://')) {
      return directDecode;
    }
  } catch {
    // 忽略解码错误
  }
  
  return null;
}

/**
 * 提取器: player_aaaa 格式 (苹果CMS 常用)
 */
function extractPlayerAaaa(html, pageUrl) {
  const match = html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (!match) return null;

  try {
    const playerData = JSON.parse(match[1]);
    let videoUrl = null;
    let title = '';

    // 提取标题
    if (playerData.vod_data) {
      title = playerData.vod_data.vod_name || '';
    }

    // 提取视频地址 (可能是加密的)
    if (playerData.url) {
      videoUrl = decodeUrl(playerData.url);
      
      // 如果解码失败，尝试直接使用
      if (!videoUrl && playerData.url.startsWith('http')) {
        videoUrl = playerData.url;
      }
    }

    if (videoUrl) {
      return {
        url: videoUrl,
        title: title,
        type: videoUrl.includes('.m3u8') ? 'hls' : 'direct',
        referer: pageUrl
      };
    }
  } catch (err) {
    console.error('[player_aaaa] 解析失败:', err.message);
  }

  return null;
}

/**
 * 提取器: player_config 格式
 */
function extractPlayerConfig(html, pageUrl) {
  const patterns = [
    /var\s+player_config\s*=\s*(\{[\s\S]*?\});/,
    /player_config\s*:\s*(\{[\s\S]*?\}),/,
    /"player_config"\s*:\s*(\{[\s\S]*?\})/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        const config = JSON.parse(match[1]);
        const videoUrl = config.url || config.video_url || config.src;
        if (videoUrl) {
          const decoded = decodeUrl(videoUrl) || videoUrl;
          if (decoded.startsWith('http')) {
            return {
              url: decoded,
              title: config.title || '',
              type: decoded.includes('.m3u8') ? 'hls' : 'direct',
              referer: pageUrl
            };
          }
        }
      } catch {
        // 继续尝试
      }
    }
  }

  return null;
}

/**
 * 提取器: iframe 嵌套
 */
async function extractIframeSrc(html, pageUrl) {
  // 查找播放器 iframe
  const iframePatterns = [
    /<iframe[^>]+src=["']([^"']+player[^"']+)["']/i,
    /<iframe[^>]+src=["']([^"']+play[^"']+)["']/i,
    /<iframe[^>]+src=["']([^"']+video[^"']+)["']/i
  ];

  for (const pattern of iframePatterns) {
    const match = html.match(pattern);
    if (match) {
      let iframeSrc = match[1];
      
      // 处理相对路径
      if (!iframeSrc.startsWith('http')) {
        const urlObj = new URL(pageUrl);
        iframeSrc = new URL(iframeSrc, urlObj.origin).href;
      }

      // 获取 iframe 内容并递归提取
      try {
        const iframeHtml = await fetchPage(iframeSrc);
        const result = await extractDirectUrl(iframeHtml, iframeSrc);
        if (result) return result;
      } catch {
        // 继续
      }
    }
  }

  return null;
}

/**
 * 提取器: 直接 m3u8/mp4 链接
 */
function extractDirectUrl(html, pageUrl) {
  // 常见的视频 URL 模式
  const patterns = [
    // m3u8 链接
    /["'](https?:\/\/[^"']+\.m3u8[^"']*?)["']/gi,
    // mp4 链接
    /["'](https?:\/\/[^"']+\.mp4[^"']*?)["']/gi,
    // 通用视频链接
    /["']?(https?:\/\/[^"'\s]+(?:index|playlist|video)\.m3u8[^"'\s]*?)["']?/gi,
    // source 标签
    /<source[^>]+src=["']([^"']+)["']/gi
  ];

  const urls = new Set();
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const url = match[1];
      // 过滤掉一些无效的链接
      if (url && 
          !url.includes('example.com') && 
          !url.includes('placeholder') &&
          !url.includes('.css') &&
          !url.includes('.js')) {
        urls.add(url);
      }
    }
  }

  // 优先返回 m3u8
  for (const url of urls) {
    if (url.includes('.m3u8')) {
      return {
        url: url,
        title: '',
        type: 'hls',
        referer: pageUrl
      };
    }
  }

  // 其次返回 mp4
  for (const url of urls) {
    if (url.includes('.mp4')) {
      return {
        url: url,
        title: '',
        type: 'direct',
        referer: pageUrl
      };
    }
  }

  return null;
}

/**
 * 提取器: JSON 播放器配置
 */
function extractJsonPlayer(html, pageUrl) {
  // 查找 JSON 格式的播放器配置
  const patterns = [
    /\{[^{}]*"url"\s*:\s*"([^"]+\.m3u8[^"]*)"/g,
    /\{[^{}]*"video"\s*:\s*"([^"]+\.m3u8[^"]*)"/g,
    /\{[^{}]*"src"\s*:\s*"([^"]+\.m3u8[^"]*)"/g,
    /\{[^{}]*"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/g
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) {
      let url = match[1];
      // 处理转义
      url = url.replace(/\\/g, '');
      
      if (url.startsWith('http')) {
        return {
          url: url,
          title: '',
          type: 'hls',
          referer: pageUrl
        };
      }
    }
  }

  return null;
}

/**
 * 检查是否是影视聚合站
 */
function isMovieSite(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    
    // 常见影视站特征
    const movieSiteKeywords = [
      'movie', 'film', 'video', 'play', 'vod',
      'tv', 'drama', 'anime', 'netflix', 'hd',
      'yy', 'zy', 'gc', 'cms'
    ];
    
    // 检查域名是否包含这些关键词
    for (const keyword of movieSiteKeywords) {
      if (hostname.includes(keyword)) {
        return true;
      }
    }
    
    // 检查路径是否包含 play
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.includes('/play/') || pathname.includes('/video/') || pathname.includes('/vod/')) {
      return true;
    }
    
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  extractVideoUrl,
  fetchPage,
  decodeUrl,
  isMovieSite
};
