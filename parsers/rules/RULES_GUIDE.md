# 视频解析规则编写指南

本文档介绍如何为 WatchTogether 编写第三方网站视频解析规则。

## 规则文件位置

- **系统规则**: `parsers/rules/*.json` - 随项目发布的内置规则
- **用户规则**: `parsers/rules/user/*.json` - 用户自定义规则（优先级更高）

## 基本结构

```json
{
  "name": "规则名称",
  "version": "1.0.0",
  "author": "作者",
  "description": "规则描述",
  "enabled": true,
  "priority": 10,
  
  "match": { ... },
  "request": { ... },
  "extract": [ ... ],
  "decode": [ ... ],
  "validate": { ... },
  "output": { ... }
}
```

## 字段详解

### match - URL 匹配规则

```json
{
  "match": {
    "domains": ["example.com", "*.example.org"],
    "pathPattern": "/video/\\d+\\.html",
    "urlPattern": "example\\.com/play/"
  }
}
```

| 字段 | 说明 |
|------|------|
| `domains` | 域名列表，支持 `*` 通配符。`*.example.com` 匹配所有子域名 |
| `pathPattern` | 路径正则表达式（可选） |
| `urlPattern` | 完整 URL 正则表达式（可选） |

### request - 请求配置

```json
{
  "request": {
    "headers": {
      "User-Agent": "自定义 UA",
      "Cookie": "xxx=yyy"
    },
    "timeout": 15000,
    "followRedirect": true
  }
}
```

### extract - 提取器

提取器按数组顺序尝试，第一个成功的结果将被使用。

#### 正则提取器

```json
{
  "name": "player_config",
  "type": "regex",
  "target": "script",
  "pattern": "var config = (\\{.*?\\});",
  "group": 1
}
```

| 字段 | 说明 |
|------|------|
| `type` | `regex` - 正则表达式提取 |
| `target` | `html` 整个页面，`script` 仅 script 标签内容 |
| `pattern` | 正则表达式 |
| `group` | 匹配组索引，默认 1 |

#### JSON 字段提取

```json
{
  "name": "player_aaaa",
  "type": "regex",
  "pattern": "var player_aaaa = (\\{[\\s\\S]*?\\});",
  "group": 1,
  "fields": {
    "url": "url",
    "title": "vod_data.vod_name"
  }
}
```

`fields` 映射 JSON 路径到输出字段，支持的字段：
- `url` - 视频地址（必须）
- `title` - 视频标题
- `thumbnail` - 缩略图

#### JSON 路径提取器

```json
{
  "type": "jsonPath",
  "pattern": "data.video.url"
}
```

### decode - 解码器链

按顺序对提取的 URL 进行解码：

```json
{
  "decode": [
    { "type": "base64" },
    { "type": "url" }
  ]
}
```

| 类型 | 说明 |
|------|------|
| `base64` | Base64 解码 |
| `url` | URL 解码 (decodeURIComponent) |
| `hex` | 十六进制解码 |
| `unicode` | Unicode 转义解码 (\uXXXX) |
| `reverse` | 字符串反转 |
| `custom` | 自定义正则替换 |

自定义解码示例：

```json
{
  "type": "custom",
  "pattern": "^//",
  "replacement": "https://"
}
```

### validate - 验证规则

```json
{
  "validate": {
    "pattern": "^https?://.*\\.m3u8",
    "extensions": ["m3u8", "mp4", "flv"]
  }
}
```

### output - 输出配置

```json
{
  "output": {
    "type": "auto",
    "referer": "{origin}",
    "headers": {
      "X-Custom-Header": "value"
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `type` | `auto` 自动检测，`hls` M3U8，`dash` MPD，`direct` 直接播放 |
| `referer` | 播放 Referer，支持 `{origin}` 和 `{url}` 占位符 |
| `headers` | 额外请求头 |

## 示例规则

### 苹果CMS 通用规则

```json
{
  "name": "苹果CMS通用规则",
  "version": "1.0.0",
  "author": "System",
  "description": "支持使用苹果CMS系统的影视站",
  "enabled": true,
  "priority": 10,
  
  "match": {
    "domains": ["*"],
    "pathPattern": "/(play|video|vod)/.*\\.html?"
  },
  
  "extract": [
    {
      "name": "player_aaaa",
      "type": "regex",
      "pattern": "var\\s+player_aaaa\\s*=\\s*(\\{[\\s\\S]*?\\});",
      "group": 1,
      "fields": {
        "url": "url"
      }
    }
  ],
  
  "decode": [
    { "type": "base64" },
    { "type": "url" }
  ],
  
  "validate": {
    "extensions": ["m3u8", "mp4"]
  },
  
  "output": {
    "type": "auto",
    "referer": "{origin}"
  }
}
```

### 直链提取规则

```json
{
  "name": "直链提取",
  "version": "1.0.0",
  "description": "提取页面中的直接视频链接",
  "priority": 1,
  
  "match": {
    "domains": ["*"]
  },
  
  "extract": [
    {
      "name": "m3u8_link",
      "type": "regex",
      "pattern": "(https?://[^\"'\\s]+\\.m3u8[^\"'\\s]*)",
      "group": 1
    },
    {
      "name": "mp4_link",
      "type": "regex",
      "pattern": "(https?://[^\"'\\s]+\\.mp4[^\"'\\s]*)",
      "group": 1
    }
  ],
  
  "output": {
    "type": "auto"
  }
}
```

## API 接口

### 获取规则列表

```http
GET /api/parser/rules
```

### 添加用户规则

```http
POST /api/parser/rules
Content-Type: application/json

{
  "rule": { ... },
  "filename": "my-rule.json"
}
```

### 删除用户规则

```http
DELETE /api/parser/rules/:filename
```

### 测试规则

```http
POST /api/parser/rules/test
Content-Type: application/json

{
  "rule": { ... },
  "testUrl": "https://example.com/video/123.html"
}
```

### 重新加载规则

```http
POST /api/parser/rules/reload
```

## 调试技巧

1. **优先级设置**：新规则设置较高的 `priority` 值，确保优先被匹配
2. **域名通配**：开发时可用 `["*"]` 匹配所有域名，完成后改为精确域名
3. **控制台日志**：服务器会输出规则匹配和提取过程的日志
4. **测试 API**：使用 `/api/parser/rules/test` 在不保存规则的情况下测试

## 贡献规则

欢迎提交 PR 贡献新的规则！请确保：

1. 规则文件放在 `parsers/rules/` 目录
2. 文件名使用小写字母和连字符，如 `my-site.json`
3. 包含完整的 `name`、`version`、`author`、`description`
4. 测试规则可以正常工作
