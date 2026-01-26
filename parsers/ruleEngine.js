/**
 * 视频解析规则引擎
 * 支持通过 JSON 规则文件扩展解析能力
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// 规则目录
const RULES_DIR = path.join(__dirname, 'rules');
const USER_RULES_DIR = path.join(RULES_DIR, 'user');

// 已加载的规则缓存
let loadedRules = [];
let rulesLoadedAt = 0;

/**
 * 加载所有规则
 * @param {boolean} forceReload - 强制重新加载
 */
function loadRules(forceReload = false) {
  // 缓存5分钟
  if (!forceReload && loadedRules.length > 0 && Date.now() - rulesLoadedAt < 5 * 60 * 1000) {
    return loadedRules;
  }

  const rules = [];

  // 加载系统规则
  loadRulesFromDir(RULES_DIR, rules, 'system');

  // 加载用户规则（如果存在）
  if (fs.existsSync(USER_RULES_DIR)) {
    loadRulesFromDir(USER_RULES_DIR, rules, 'user');
  }

  // 按优先级排序（高优先级在前）
  rules.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  loadedRules = rules;
  rulesLoadedAt = Date.now();

  console.log(`[规则引擎] 已加载 ${rules.length} 条规则`);
  return rules;
}

/**
 * 从目录加载规则文件
 */
function loadRulesFromDir(dir, rules, source) {
  try {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'schema.json') continue;
      
      const filePath = path.join(dir, file);
      
      // 跳过目录
      if (fs.statSync(filePath).isDirectory()) continue;
      
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const rule = JSON.parse(content);
        
        // 验证规则
        if (!validateRule(rule)) {
          console.warn(`[规则引擎] 规则无效，跳过: ${file}`);
          continue;
        }
        
        // 添加元信息
        rule._file = file;
        rule._source = source;
        rule._path = filePath;
        
        // 只加载启用的规则
        if (rule.enabled !== false) {
          rules.push(rule);
        }
      } catch (err) {
        console.error(`[规则引擎] 加载规则失败 ${file}:`, err.message);
      }
    }
  } catch (err) {
    // 目录不存在等错误
  }
}

/**
 * 验证规则格式
 */
function validateRule(rule) {
  if (!rule.name || !rule.match || !rule.extract) {
    return false;
  }
  
  if (!rule.match.domains || !Array.isArray(rule.match.domains)) {
    return false;
  }
  
  if (!Array.isArray(rule.extract) || rule.extract.length === 0) {
    return false;
  }
  
  return true;
}

/**
 * 查找匹配的规则
 */
function findMatchingRules(url) {
  const rules = loadRules();
  const matched = [];
  
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    const pathname = urlObj.pathname;
    
    for (const rule of rules) {
      if (matchRule(rule, hostname, pathname, url)) {
        matched.push(rule);
      }
    }
  } catch {
    // URL 解析失败
  }
  
  return matched;
}

/**
 * 检查规则是否匹配
 */
function matchRule(rule, hostname, pathname, fullUrl) {
  const { match } = rule;
  
  // 匹配域名
  let domainMatched = false;
  for (const domain of match.domains) {
    if (domain === '*') {
      domainMatched = true;
      break;
    }
    
    // 支持通配符
    if (domain.startsWith('*.')) {
      const baseDomain = domain.slice(2);
      if (hostname === baseDomain || hostname.endsWith('.' + baseDomain)) {
        domainMatched = true;
        break;
      }
    } else if (hostname === domain || hostname === 'www.' + domain || hostname.endsWith('.' + domain)) {
      domainMatched = true;
      break;
    }
  }
  
  if (!domainMatched) return false;
  
  // 匹配路径
  if (match.pathPattern) {
    try {
      const pathRegex = new RegExp(match.pathPattern, 'i');
      if (!pathRegex.test(pathname)) return false;
    } catch {
      return false;
    }
  }
  
  // 匹配完整 URL
  if (match.urlPattern) {
    try {
      const urlRegex = new RegExp(match.urlPattern, 'i');
      if (!urlRegex.test(fullUrl)) return false;
    } catch {
      return false;
    }
  }
  
  return true;
}

/**
 * 使用规则提取视频
 */
async function extractWithRules(url, options = {}) {
  const matchedRules = findMatchingRules(url);
  
  if (matchedRules.length === 0) {
    throw new Error('没有匹配的解析规则');
  }
  
  console.log(`[规则引擎] 找到 ${matchedRules.length} 条匹配规则`);
  
  // 获取网页内容
  const html = await fetchPage(url, matchedRules[0].request);
  
  // 尝试每条规则
  for (const rule of matchedRules) {
    try {
      const result = await applyRule(rule, html, url);
      if (result && result.url) {
        console.log(`[规则引擎] 规则 "${rule.name}" 提取成功`);
        return {
          ...result,
          rule: rule.name,
          ruleVersion: rule.version
        };
      }
    } catch (err) {
      console.log(`[规则引擎] 规则 "${rule.name}" 失败:`, err.message);
    }
  }
  
  throw new Error('所有规则均无法提取视频地址');
}

/**
 * 应用单条规则
 */
async function applyRule(rule, html, pageUrl) {
  let videoUrl = null;
  let title = '';
  let thumbnail = '';
  
  // 尝试每个提取器
  for (const extractor of rule.extract) {
    try {
      const extracted = applyExtractor(extractor, html);
      
      if (extracted) {
        // 如果是对象（包含多个字段）
        if (typeof extracted === 'object' && extracted.url) {
          videoUrl = extracted.url;
          title = extracted.title || title;
          thumbnail = extracted.thumbnail || thumbnail;
        } else if (typeof extracted === 'string') {
          videoUrl = extracted;
        }
        
        if (videoUrl) {
          console.log(`[规则引擎] 提取器 "${extractor.name || extractor.type}" 成功`);
          break;
        }
      }
    } catch (err) {
      // 继续尝试下一个提取器
    }
  }
  
  if (!videoUrl) return null;
  
  // 应用解码规则
  if (rule.decode && Array.isArray(rule.decode)) {
    for (const decoder of rule.decode) {
      videoUrl = applyDecoder(decoder, videoUrl);
    }
  }
  
  // 验证 URL
  if (rule.validate) {
    if (!validateUrl(videoUrl, rule.validate)) {
      return null;
    }
  }
  
  // 确定输出类型
  const output = rule.output || {};
  let type = output.type || 'auto';
  
  if (type === 'auto') {
    if (videoUrl.includes('.m3u8')) type = 'hls';
    else if (videoUrl.includes('.mpd')) type = 'dash';
    else type = 'direct';
  }
  
  // 处理 referer
  let referer = output.referer || pageUrl;
  const urlObj = new URL(pageUrl);
  referer = referer
    .replace('{origin}', urlObj.origin)
    .replace('{url}', pageUrl);
  
  return {
    url: videoUrl,
    title,
    thumbnail,
    type,
    referer,
    headers: output.headers
  };
}

/**
 * 应用提取器
 */
function applyExtractor(extractor, html) {
  const { type, pattern, group = 1, fields, target = 'html' } = extractor;
  
  // 准备目标内容
  let content = html;
  
  if (target === 'script') {
    // 只提取 script 标签内容
    const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    content = scripts.join('\n');
  }
  
  switch (type) {
    case 'regex': {
      const regex = new RegExp(pattern, 'i');
      const match = content.match(regex);
      
      if (!match) return null;
      
      let extracted = match[group] || match[0];
      
      // 如果有 fields 配置，尝试解析为 JSON 并提取字段
      if (fields && extracted.startsWith('{')) {
        try {
          const json = JSON.parse(extracted);
          return extractFields(json, fields);
        } catch {
          // 不是有效 JSON，返回原值
        }
      }
      
      return extracted;
    }
    
    case 'json': {
      // 先用正则提取 JSON
      const regex = new RegExp(pattern, 'i');
      const match = content.match(regex);
      if (!match) return null;
      
      try {
        const json = JSON.parse(match[group] || match[0]);
        return fields ? extractFields(json, fields) : json;
      } catch {
        return null;
      }
    }
    
    case 'jsonPath': {
      // JSON 路径提取（简单实现）
      try {
        // 先找到 JSON 对象
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        
        const json = JSON.parse(jsonMatch[0]);
        return getNestedValue(json, pattern);
      } catch {
        return null;
      }
    }
    
    default:
      return null;
  }
}

/**
 * 从 JSON 对象提取多个字段
 */
function extractFields(json, fields) {
  const result = {};
  
  for (const [key, path] of Object.entries(fields)) {
    const value = getNestedValue(json, path);
    if (value !== undefined) {
      result[key] = value;
    }
  }
  
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * 获取嵌套对象的值
 */
function getNestedValue(obj, path) {
  if (!path || !obj) return undefined;
  
  const keys = path.split('.');
  let value = obj;
  
  for (const key of keys) {
    if (value === null || value === undefined) return undefined;
    value = value[key];
  }
  
  return value;
}

/**
 * 应用解码器
 */
function applyDecoder(decoder, value) {
  if (!value) return value;
  
  try {
    switch (decoder.type) {
      case 'base64':
        return Buffer.from(value, 'base64').toString('utf-8');
        
      case 'url':
        return decodeURIComponent(value);
        
      case 'hex':
        return Buffer.from(value, 'hex').toString('utf-8');
        
      case 'unicode':
        return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => 
          String.fromCharCode(parseInt(code, 16))
        );
        
      case 'reverse':
        return value.split('').reverse().join('');
        
      case 'custom':
        if (decoder.pattern && decoder.replacement !== undefined) {
          const regex = new RegExp(decoder.pattern, 'g');
          return value.replace(regex, decoder.replacement);
        }
        return value;
        
      default:
        return value;
    }
  } catch {
    return value;
  }
}

/**
 * 验证 URL
 */
function validateUrl(url, rules) {
  if (!url) return false;
  
  // 正则验证
  if (rules.pattern) {
    try {
      const regex = new RegExp(rules.pattern);
      if (!regex.test(url)) return false;
    } catch {
      return false;
    }
  }
  
  // 扩展名验证
  if (rules.extensions && Array.isArray(rules.extensions)) {
    const hasValidExt = rules.extensions.some(ext => 
      url.toLowerCase().includes('.' + ext.toLowerCase())
    );
    if (!hasValidExt) return false;
  }
  
  return true;
}

/**
 * 获取网页内容
 */
function fetchPage(url, requestConfig = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    
    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': urlObj.origin
    };
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { ...defaultHeaders, ...requestConfig.headers },
      timeout: requestConfig.timeout || 15000
    };
    
    const req = protocol.request(options, (res) => {
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (requestConfig.followRedirect !== false) {
          const redirectUrl = new URL(res.headers.location, url).href;
          fetchPage(redirectUrl, requestConfig).then(resolve).catch(reject);
          return;
        }
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
 * 获取所有已加载的规则信息
 */
function getRulesInfo() {
  const rules = loadRules();
  return rules.map(rule => ({
    name: rule.name,
    version: rule.version,
    author: rule.author,
    description: rule.description,
    enabled: rule.enabled !== false,
    priority: rule.priority || 0,
    domains: rule.match.domains,
    source: rule._source,
    file: rule._file
  }));
}

/**
 * 重新加载规则
 */
function reloadRules() {
  loadedRules = [];
  rulesLoadedAt = 0;
  return loadRules(true);
}

/**
 * 添加用户规则
 */
function addUserRule(rule, filename) {
  // 确保用户规则目录存在
  if (!fs.existsSync(USER_RULES_DIR)) {
    fs.mkdirSync(USER_RULES_DIR, { recursive: true });
  }
  
  // 验证规则
  if (!validateRule(rule)) {
    throw new Error('规则格式无效');
  }
  
  // 生成文件名
  const safeName = filename || rule.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_') + '.json';
  const filePath = path.join(USER_RULES_DIR, safeName);
  
  // 写入文件
  fs.writeFileSync(filePath, JSON.stringify(rule, null, 2), 'utf-8');
  
  // 重新加载规则
  reloadRules();
  
  return { success: true, file: safeName };
}

/**
 * 删除用户规则
 */
function removeUserRule(filename) {
  const filePath = path.join(USER_RULES_DIR, filename);
  
  if (!fs.existsSync(filePath)) {
    throw new Error('规则文件不存在');
  }
  
  fs.unlinkSync(filePath);
  reloadRules();
  
  return { success: true };
}

/**
 * 测试规则
 */
async function testRule(rule, testUrl) {
  // 临时添加规则到列表
  const testRules = [{ ...rule, priority: 9999, enabled: true }];
  
  // 获取页面
  const html = await fetchPage(testUrl, rule.request);
  
  // 应用规则
  const result = await applyRule(rule, html, testUrl);
  
  return result;
}

module.exports = {
  loadRules,
  reloadRules,
  findMatchingRules,
  extractWithRules,
  getRulesInfo,
  addUserRule,
  removeUserRule,
  testRule,
  validateRule,
  RULES_DIR,
  USER_RULES_DIR
};
