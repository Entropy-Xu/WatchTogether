/**
 * 视频解析器管理器
 * 统一接口，自动选择合适的解析器
 */

const ytdlp = require('./ytdlp');
const generic = require('./generic');
const ruleEngine = require('./ruleEngine');

// 支持的网站及其解析器映射
const SITE_PARSERS = {
  // B站专用解析器 (使用现有的 bilibili.js)
  'bilibili.com': 'bilibili',
  'b23.tv': 'bilibili',

  // yt-dlp 支持的网站 (部分列举)
  'youtube.com': 'ytdlp',
  'youtu.be': 'ytdlp',
  'twitter.com': 'ytdlp',
  'x.com': 'ytdlp',
  'weibo.com': 'ytdlp',
  'weibo.cn': 'ytdlp',
  'douyin.com': 'ytdlp',
  'tiktok.com': 'ytdlp',
  'vimeo.com': 'ytdlp',
  'dailymotion.com': 'ytdlp',
  'twitch.tv': 'ytdlp',
  'facebook.com': 'ytdlp',
  'fb.watch': 'ytdlp',
  'instagram.com': 'ytdlp',
  'reddit.com': 'ytdlp',
  'v.redd.it': 'ytdlp',
  'streamable.com': 'ytdlp',
  'pornhub.com': 'ytdlp',
  'xvideos.com': 'ytdlp',
  'nicovideo.jp': 'ytdlp',
  'nico.ms': 'ytdlp',
  'acfun.cn': 'ytdlp',
  'ixigua.com': 'ytdlp',
  'ted.com': 'ytdlp',
  'soundcloud.com': 'ytdlp',
  'bandcamp.com': 'ytdlp',
  'mixcloud.com': 'ytdlp',
};

// 支持的网站列表（用于前端显示）
const SUPPORTED_SITES = [
  { name: 'YouTube', domain: 'youtube.com', icon: 'fab fa-youtube' },
  { name: 'Twitter/X', domain: 'twitter.com', icon: 'fab fa-twitter' },
  { name: '微博', domain: 'weibo.com', icon: 'fab fa-weibo' },
  { name: '抖音', domain: 'douyin.com', icon: 'fab fa-tiktok' },
  { name: 'TikTok', domain: 'tiktok.com', icon: 'fab fa-tiktok' },
  { name: 'Vimeo', domain: 'vimeo.com', icon: 'fab fa-vimeo' },
  { name: 'Twitch', domain: 'twitch.tv', icon: 'fab fa-twitch' },
  { name: 'Facebook', domain: 'facebook.com', icon: 'fab fa-facebook' },
  { name: 'Instagram', domain: 'instagram.com', icon: 'fab fa-instagram' },
  { name: 'Reddit', domain: 'reddit.com', icon: 'fab fa-reddit' },
  { name: 'NicoNico', domain: 'nicovideo.jp', icon: 'fas fa-play-circle' },
  { name: 'AcFun', domain: 'acfun.cn', icon: 'fas fa-play-circle' },
  { name: '西瓜视频', domain: 'ixigua.com', icon: 'fas fa-play-circle' },
  { name: '影视聚合站', domain: '通用解析', icon: 'fas fa-film' },
];

// 需要手动提取 m3u8 的网站（Cloudflare 保护）
const CLOUDFLARE_PROTECTED_SITES = [
  'jable.tv',
  'hanime.tv',
  'avgle.com',
  'thisav.com',
  'supjav.com'
];

/**
 * 检查是否是需要手动提取的网站
 */
function isManualExtractSite(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return CLOUDFLARE_PROTECTED_SITES.some(site => hostname.includes(site));
  } catch {
    return false;
  }
}

/**
 * 检测 URL 应使用哪个解析器
 */
function detectParser(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.replace('www.', '').replace('m.', '');

    for (const [domain, parser] of Object.entries(SITE_PARSERS)) {
      if (hostname.includes(domain)) {
        return parser;
      }
    }

    // 检查是否有匹配的自定义规则
    const matchedRules = ruleEngine.findMatchingRules(url);
    if (matchedRules.length > 0) {
      return 'rules';
    }

    // 检查是否是影视聚合站
    if (generic.isMovieSite(url)) {
      return 'generic';
    }

    // 默认尝试 yt-dlp（支持大量网站）
    return 'ytdlp';
  } catch {
    return null;
  }
}

/**
 * 获取视频信息（不下载）
 */
async function getVideoInfo(url, options = {}) {
  const parser = detectParser(url);

  if (!parser) {
    throw new Error('无法识别的 URL 格式');
  }

  if (parser === 'bilibili') {
    throw new Error('B站视频请使用专用解析按钮');
  }

  // 检查是否是需要手动提取的网站
  if (isManualExtractSite(url)) {
    throw new Error('此网站有 Cloudflare 保护，无法自动解析。\n\n请按以下步骤手动获取视频地址：\n1. 在浏览器中打开视频页面并播放\n2. 按 F12 打开开发者工具\n3. 切换到 Network (网络) 标签页\n4. 在筛选框中输入 "m3u8"\n5. 复制找到的 .m3u8 链接\n6. 将链接粘贴到"视频链接"输入框中直接加载');
  }

  // 使用自定义规则解析
  if (parser === 'rules') {
    const result = await ruleEngine.extractWithRules(url);
    return {
      title: result.title || '视频',
      duration: 0,
      thumbnail: result.thumbnail || '',
      uploader: '',
      formats: [],
      bestFormat: null,
      extractor: `规则: ${result.rule}`,
      directUrl: result.url,
      directType: result.type,
      referer: result.referer
    };
  }

  // 影视聚合站使用通用解析器
  if (parser === 'generic') {
    const result = await generic.extractVideoUrl(url);
    return {
      title: result.title || '影视视频',
      duration: 0,
      thumbnail: '',
      uploader: '',
      formats: [],
      bestFormat: null,
      extractor: '通用解析',
      directUrl: result.url,
      directType: result.type,
      referer: result.referer
    };
  }

  // 使用 yt-dlp
  try {
    return await ytdlp.getInfo(url, options);
  } catch (err) {
    // 如果 yt-dlp 失败，尝试自定义规则
    console.log('[解析] yt-dlp 失败，尝试规则引擎:', err.message);
    try {
      const result = await ruleEngine.extractWithRules(url);
      return {
        title: result.title || '视频',
        duration: 0,
        thumbnail: result.thumbnail || '',
        uploader: '',
        formats: [],
        bestFormat: null,
        extractor: `规则: ${result.rule}`,
        directUrl: result.url,
        directType: result.type,
        referer: result.referer
      };
    } catch (ruleErr) {
      // 规则引擎失败，尝试通用解析器
      console.log('[解析] 规则引擎失败，尝试通用解析器:', ruleErr.message);
      try {
        const result = await generic.extractVideoUrl(url);
        return {
          title: result.title || '视频',
          duration: 0,
          thumbnail: '',
          uploader: '',
          formats: [],
          bestFormat: null,
          extractor: '通用解析',
          directUrl: result.url,
          directType: result.type,
          referer: result.referer
        };
      } catch (genericErr) {
        // 全部失败，抛出原始错误
        throw err;
      }
    }
  }
}

/**
 * 解析并获取直接播放地址或下载视频
 */
async function parseVideo(url, options = {}) {
  const parser = detectParser(url);

  if (parser === 'bilibili') {
    throw new Error('B站视频请使用专用解析按钮');
  }

  // 使用自定义规则解析
  if (parser === 'rules') {
    const result = await ruleEngine.extractWithRules(url);
    options.onProgress?.({
      stage: 'complete',
      progress: 100,
      message: `规则 "${result.rule}" 解析完成`
    });
    return {
      type: result.type === 'hls' ? 'hls' : 'direct',
      url: result.url,
      title: result.title || '视频',
      duration: 0,
      thumbnail: result.thumbnail || '',
      needsProxy: false,
      referer: result.referer
    };
  }

  // 影视聚合站使用通用解析器
  if (parser === 'generic') {
    const result = await generic.extractVideoUrl(url);
    options.onProgress?.({
      stage: 'complete',
      progress: 100,
      message: '解析完成'
    });
    return {
      type: result.type === 'hls' ? 'hls' : 'direct',
      url: result.url,
      title: result.title || '影视视频',
      duration: 0,
      thumbnail: '',
      needsProxy: false,  // HLS 通常不需要代理
      referer: result.referer
    };
  }

  // 使用 yt-dlp
  try {
    return await ytdlp.extract(url, options);
  } catch (err) {
    // 如果 yt-dlp 失败，尝试规则引擎
    console.log('[解析] yt-dlp 失败，尝试规则引擎:', err.message);
    try {
      const result = await ruleEngine.extractWithRules(url);
      options.onProgress?.({
        stage: 'complete',
        progress: 100,
        message: `规则 "${result.rule}" 解析完成`
      });
      return {
        type: result.type === 'hls' ? 'hls' : 'direct',
        url: result.url,
        title: result.title || '视频',
        duration: 0,
        thumbnail: result.thumbnail || '',
        needsProxy: false,
        referer: result.referer
      };
    } catch (ruleErr) {
      // 规则引擎失败，尝试通用解析器
      console.log('[解析] 规则引擎失败，尝试通用解析器:', ruleErr.message);
      try {
        const result = await generic.extractVideoUrl(url);
        options.onProgress?.({
          stage: 'complete',
          progress: 100,
          message: '解析完成'
        });
        return {
          type: result.type === 'hls' ? 'hls' : 'direct',
          url: result.url,
          title: result.title || '视频',
          duration: 0,
          thumbnail: '',
          needsProxy: false,
          referer: result.referer
        };
      } catch (genericErr) {
        throw err;
      }
    }
  }
}

/**
 * 检查 yt-dlp 是否可用
 */
async function checkYtdlpAvailable() {
  return await ytdlp.isAvailable();
}

/**
 * 更新 yt-dlp
 */
async function updateYtdlp() {
  return await ytdlp.update();
}

module.exports = {
  detectParser,
  getVideoInfo,
  parseVideo,
  checkYtdlpAvailable,
  updateYtdlp,
  isManualExtractSite,
  SITE_PARSERS,
  SUPPORTED_SITES,
  CLOUDFLARE_PROTECTED_SITES,
  // 规则引擎相关
  getRulesInfo: ruleEngine.getRulesInfo,
  reloadRules: ruleEngine.reloadRules,
  addUserRule: ruleEngine.addUserRule,
  removeUserRule: ruleEngine.removeUserRule,
  testRule: ruleEngine.testRule
};
