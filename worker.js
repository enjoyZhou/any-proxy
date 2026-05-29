/**
 * Cloudflare Worker - anyrouter.top 反向代理
 *
 * 功能说明：
 * 1. 接收所有请求并转发到 anyrouter.top
 * 2. 转发原始请求的方法、必要 headers 和 body 流
 * 3. 自动重写 HTML/CSS/JS 中的绝对 URL，确保所有资源都通过代理访问
 * 4. 返回目标网站的响应
 * 5. 支持 WebSocket、SSE 和其他流式响应透传
 */

// 目标网站地址
const TARGET_HOST = 'anyrouter.top';
const TARGET_URL = `https://${TARGET_HOST}`;

// Hop-by-hop headers 不应在代理请求/响应中透传。
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding'
];

// 这些类型必须保持流式透传，不能调用 response.text() 读完整响应。
const STREAMING_CONTENT_TYPES = [
  'text/event-stream',
  'application/x-ndjson',
  'application/stream+json',
  'application/grpc',
  'application/grpc-web'
];

const TEXT_CONTENT_TYPES = [
  'application/ecmascript',
  'application/importmap+json',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'application/rss+xml',
  'application/atom+xml',
  'application/xml',
  'application/xhtml+xml',
  'application/x-javascript',
  'image/svg+xml',
  'text/css',
  'text/csv',
  'text/ecmascript',
  'text/html',
  'text/javascript',
  'text/markdown',
  'text/plain',
  'text/xml'
];

const TEXT_CONTENT_SUFFIXES = [
  '+json',
  '+xml'
];

const BINARY_CONTENT_TYPES = [
  'application/font-woff',
  'application/font-woff2',
  'application/gzip',
  'application/java-archive',
  'application/octet-stream',
  'application/pdf',
  'application/vnd.ms-fontobject',
  'application/wasm',
  'application/x-7z-compressed',
  'application/x-font-ttf',
  'application/x-tar',
  'application/zip',
  'font/collection',
  'font/otf',
  'font/sfnt',
  'font/ttf',
  'font/woff',
  'font/woff2'
];

if (typeof addEventListener === 'function') {
  addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
  });
}

/**
 * 处理传入的请求
 * @param {Request} request - 原始请求对象
 * @returns {Response} - 代理后的响应
 */
async function handleRequest(request) {
  try {
    // 解析请求的 URL
    const url = new URL(request.url);

    // 调试信息
    console.log('=== 收到新请求 ===');
    console.log('请求URL:', request.url);
    console.log('请求方法:', request.method);

    // CORS 预检请求直接返回，避免无意义转发到目标站点。
    if (request.method === 'OPTIONS') {
      return handleOptionsRequest(request);
    }

    // 记录请求头
    console.log('\n--- 请求 Headers ---');
    const headers = buildProxyRequestHeaders(request, url);
    headers.forEach((value, key) => {
      console.log(`${key}: ${value}`);
    });

    // 构建目标 URL，保持原始路径和查询参数
    const targetUrl = `${TARGET_URL}${url.pathname}${url.search}`;
    console.log('\n--- 目标信息 ---');
    console.log('目标URL:', targetUrl);

    // WebSocket 需要在普通 HTTP 响应处理前分流，否则 101 握手不能正确透传。
    if (isWebSocketRequest(request)) {
      return handleWebSocketProxy(request, targetUrl, headers);
    }

    // 构建新的请求选项
    const requestOptions = {
      method: request.method,
      headers: headers,
      redirect: 'manual',  // 不自动跟随重定向，避免重定向循环
    };

    // 如果请求有 body（POST、PUT 等），直接透传流，避免大请求体被完整读入内存。
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      requestOptions.body = request.body;
    }

    // 发起代理请求
    console.log('\n--- 发起代理请求 ---');
    const response = await fetch(targetUrl, requestOptions);
    console.log('目标响应状态:', response.status, response.statusText);

    // 手动处理重定向状态码
    if (response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308) {
      const location = response.headers.get('Location');
      console.log('\n--- 重定向检测 ---');
      console.log('检测到重定向，Location:', location);

      const responseHeaders = buildProxyResponseHeaders(response.headers, request);
      if (location) {
        responseHeaders.set('Location', rewriteRedirectLocation(location, request.url));
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    }

    // 修改响应头，处理 CORS
    const responseHeaders = buildProxyResponseHeaders(response.headers, request);

    // 获取响应内容类型
    const contentType = responseHeaders.get('content-type') || '';
    console.log('\n--- 响应 Headers ---');
    responseHeaders.forEach((value, key) => {
      console.log(`${key}: ${value}`);
    });

    // 检查是否是文本内容类型（只有这些才需要 URL 重写）
    const isTextContent = isTextContentType(contentType);

    // SSE、NDJSON、gRPC 等长连接/流式响应必须直接返回 response.body。
    if (isStreamingResponse(contentType, request)) {
      console.log('\n--- 响应 Body (流式内容) ---');
      console.log('内容类型:', contentType);
      prepareStreamingHeaders(responseHeaders, contentType);

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    }

    // 如果是文本内容，需要重写其中的 URL
    if (isTextContent) {
      try {
        console.log('\n--- 响应 Body (文本内容) ---');
        console.log('尝试读取文本内容...');
        const text = await response.text();
        const contentLength = text.length;
        console.log(`内容长度: ${contentLength} 字符`);

        const rewrittenText = rewriteUrlsInContent(text, request.url, TARGET_URL);
        console.log('\n--- URL 重写完成 ---');
        prepareRewrittenTextHeaders(responseHeaders);

        return new Response(rewrittenText, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      } catch (error) {
        // 如果文本转换失败，直接返回原始响应
        console.error('\n!!! 文本转换失败 !!!');
        console.error('错误类型:', error.name);
        console.error('错误消息:', error.message);
        console.error('错误堆栈:', error.stack);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      }
    }

    // 对于二进制文件（图片、视频等），直接返回原始响应
    console.log('\n--- 响应 Body (二进制内容) ---');
    console.log('内容类型:', contentType);
    console.log('直接返回二进制内容');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });

  } catch (error) {
    // 错误处理
    console.error('\n!!! 代理请求失败 !!!');
    console.error('错误类型:', error.name);
    console.error('错误消息:', error.message);
    console.error('错误堆栈:', error.stack);
    return new Response(`代理请求失败: ${error.message}`, {
      status: 500,
      headers: buildErrorResponseHeaders(request)
    });
  }
}

/**
 * 构建代理请求头。
 * @param {Request} request - 原始请求
 * @param {URL} proxyUrl - 代理请求 URL
 * @returns {Headers} - 可转发到目标站点的请求头
 */
function buildProxyRequestHeaders(request, proxyUrl) {
  const headers = new Headers(request.headers);

  HOP_BY_HOP_HEADERS.forEach(header => headers.delete(header));

  if (isWebSocketRequest(request)) {
    headers.set('Upgrade', 'websocket');
    headers.delete('Sec-WebSocket-Key');
    headers.delete('Sec-WebSocket-Version');
    headers.delete('Sec-WebSocket-Accept');
  } else {
    headers.delete('Upgrade');
  }

  if (isSseRequest(request)) {
    headers.set('Accept-Encoding', 'identity');
  }

  headers.set('Host', TARGET_HOST);

  if (headers.has('Origin')) {
    headers.set('Origin', TARGET_URL);
  }

  if (headers.has('Referer')) {
    const referer = headers.get('Referer');
    try {
      const refererUrl = new URL(referer);
      headers.set('Referer', `${TARGET_URL}${refererUrl.pathname}${refererUrl.search}${refererUrl.hash}`);
    } catch (e) {
      headers.set('Referer', `${TARGET_URL}${proxyUrl.pathname}${proxyUrl.search}${proxyUrl.hash}`);
    }
  }

  return headers;
}

/**
 * 构建代理响应头。
 * @param {Headers} sourceHeaders - 目标站点响应头
 * @param {Request} request - 原始请求
 * @returns {Headers} - 返回给客户端的响应头
 */
function buildProxyResponseHeaders(sourceHeaders, request) {
  const headers = new Headers(sourceHeaders);

  HOP_BY_HOP_HEADERS.forEach(header => headers.delete(header));

  headers.delete('Content-Security-Policy');
  headers.delete('Content-Security-Policy-Report-Only');
  headers.delete('X-Frame-Options');

  applyCorsHeaders(headers, request);

  return headers;
}

/**
 * 构建错误响应头。
 * @param {Request} request - 原始请求
 * @returns {Headers} - 错误响应头
 */
function buildErrorResponseHeaders(request) {
  const headers = new Headers({
    'Content-Type': 'text/plain; charset=utf-8'
  });
  applyCorsHeaders(headers, request);
  return headers;
}

/**
 * 处理 CORS 预检请求。
 * @param {Request} request - 原始请求
 * @returns {Response} - 预检响应
 */
function handleOptionsRequest(request) {
  const headers = new Headers();
  applyCorsHeaders(headers, request);
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

/**
 * 应用 CORS 响应头。
 * @param {Headers} headers - 响应头
 * @param {Request} request - 原始请求
 */
function applyCorsHeaders(headers, request) {
  const origin = request.headers.get('Origin');
  const requestedHeaders = request.headers.get('Access-Control-Request-Headers');

  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    appendVary(headers, 'Origin');
  } else {
    headers.set('Access-Control-Allow-Origin', '*');
  }

  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', requestedHeaders || '*');
  headers.set('Access-Control-Expose-Headers', 'Content-Type, Content-Length, Location');
}

/**
 * 追加 Vary 值，避免覆盖目标站点已有缓存维度。
 * @param {Headers} headers - 响应头
 * @param {string} value - Vary 值
 */
function appendVary(headers, value) {
  const current = headers.get('Vary');
  if (!current) {
    headers.set('Vary', value);
    return;
  }

  const values = current.split(',').map(item => item.trim().toLowerCase());
  if (!values.includes(value.toLowerCase())) {
    headers.set('Vary', `${current}, ${value}`);
  }
}

/**
 * 判断是否是 WebSocket Upgrade 请求。
 * @param {Request} request - 原始请求
 * @returns {boolean} - 是否是 WebSocket 请求
 */
function isWebSocketRequest(request) {
  return (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';
}

/**
 * 转发 WebSocket 握手，握手成功后由 Workers Runtime 透传连接。
 * @param {Request} request - 原始请求
 * @param {string} targetUrl - 目标 URL
 * @param {Headers} headers - 已重写的请求头
 * @returns {Promise<Response>} - WebSocket 或错误响应
 */
async function handleWebSocketProxy(request, targetUrl, headers) {
  console.log('\n--- WebSocket 代理 ---');

  if (request.method !== 'GET') {
    const errorHeaders = new Headers();
    applyCorsHeaders(errorHeaders, request);
    return new Response('WebSocket Upgrade 请求必须使用 GET 方法', {
      status: 405,
      headers: errorHeaders
    });
  }

  const response = await fetch(targetUrl, {
    method: 'GET',
    headers,
    redirect: 'manual'
  });

  console.log('WebSocket 握手响应:', response.status, response.statusText);

  if (response.webSocket) {
    return response;
  }

  const responseHeaders = buildProxyResponseHeaders(response.headers, request);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });
}

/**
 * 判断请求是否明确期望 SSE。
 * @param {Request} request - 原始请求
 * @returns {boolean} - 是否是 SSE 请求
 */
function isSseRequest(request) {
  return (request.headers.get('Accept') || '').toLowerCase().includes('text/event-stream');
}

/**
 * 判断响应是否必须保持流式透传。
 * @param {string} contentType - 响应 Content-Type
 * @param {Request} request - 原始请求
 * @returns {boolean} - 是否应直接透传响应体流
 */
function isStreamingResponse(contentType, request) {
  const mimeType = getMimeType(contentType);

  return isSseRequest(request) ||
    STREAMING_CONTENT_TYPES.includes(mimeType) ||
    mimeType.startsWith('application/grpc+') ||
    mimeType.startsWith('application/grpc-web+');
}

/**
 * 从 Content-Type 响应头提取标准 MIME 类型。
 * @param {string} contentType - 原始 Content-Type
 * @returns {string} - 小写 MIME 类型
 */
function getMimeType(contentType) {
  return (contentType || '').split(';', 1)[0].trim().toLowerCase();
}

/**
 * 判断响应体是否应按文本处理。
 * @param {string} contentType - 原始 Content-Type
 * @returns {boolean} - 是否是文本内容
 */
function isTextContentType(contentType) {
  const mimeType = getMimeType(contentType);

  if (!mimeType || BINARY_CONTENT_TYPES.includes(mimeType) || STREAMING_CONTENT_TYPES.includes(mimeType)) {
    return false;
  }

  if (TEXT_CONTENT_TYPES.includes(mimeType)) {
    return true;
  }

  const slashIndex = mimeType.indexOf('/');
  if (slashIndex === -1) {
    return false;
  }

  const topLevelType = mimeType.slice(0, slashIndex);
  const subtype = mimeType.slice(slashIndex + 1);

  if (topLevelType === 'audio' || topLevelType === 'font' || topLevelType === 'image' || topLevelType === 'video') {
    return mimeType === 'image/svg+xml';
  }

  if (topLevelType === 'text') {
    return subtype !== 'event-stream';
  }

  return TEXT_CONTENT_SUFFIXES.some(suffix => subtype.endsWith(suffix));
}

/**
 * 为流式响应补充适合代理的响应头。
 * @param {Headers} headers - 响应头
 * @param {string} contentType - 响应 Content-Type
 */
function prepareStreamingHeaders(headers, contentType) {
  headers.delete('Content-Length');

  if (contentType.toLowerCase().includes('text/event-stream')) {
    headers.set('Cache-Control', 'no-cache, no-transform');
    headers.set('X-Accel-Buffering', 'no');
  }
}

/**
 * 文本内容重写后，删除与原响应体不再匹配的头。
 * @param {Headers} headers - 响应头
 */
function prepareRewrittenTextHeaders(headers) {
  headers.delete('Content-Encoding');
  headers.delete('Content-Length');
  headers.delete('ETag');
}

/**
 * 将同源重定向地址改写为代理域名。
 * @param {string} location - 目标站点返回的 Location
 * @param {string} proxyRequestUrl - 原始代理请求 URL
 * @returns {string} - 改写后的 Location
 */
function rewriteRedirectLocation(location, proxyRequestUrl) {
  try {
    const proxyOrigin = new URL(proxyRequestUrl).origin;
    const redirectUrl = new URL(location, TARGET_URL);

    if (redirectUrl.origin === TARGET_URL) {
      return `${proxyOrigin}${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`;
    }
  } catch (e) {
    // 非法 Location 交给客户端处理。
  }

  return location;
}

/**
 * 重写内容中的绝对 URL
 * 将 anyrouter.top 的绝对 URL 替换为相对 URL，使其通过代理访问
 * @param {string} content - 原始内容
 * @param {string} proxyUrl - 代理的 URL
 * @param {string} targetUrl - 目标网站的 URL
 * @returns {string} - 重写后的内容
 */
function rewriteUrlsInContent(content, proxyUrl, targetUrl) {
  try {
    // 获取代理的 origin (例如: https://any.chaosyn.com)
    const proxyOrigin = new URL(proxyUrl).origin;

    // 使用更精确的正则表达式，避免意外匹配。
    const escapedTargetUrl = TARGET_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedTargetHttpUrl = `http://${TARGET_HOST}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedTargetHost = TARGET_HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const proxyWebSocketOrigin = proxyOrigin.replace(/^http/i, 'ws');

    let rewritten = content;

    // 重写 HTTP(S) 绝对 URL: https://anyrouter.top -> https://any.chaosyn.com
    rewritten = rewritten.replace(
      new RegExp(escapedTargetUrl, 'g'),
      proxyOrigin
    );

    rewritten = rewritten.replace(
      new RegExp(escapedTargetHttpUrl, 'g'),
      proxyOrigin
    );

    // 重写 WebSocket 绝对 URL: wss://anyrouter.top -> wss://any.chaosyn.com
    rewritten = rewritten.replace(
      new RegExp(`wss://${escapedTargetHost}`, 'g'),
      proxyWebSocketOrigin
    );

    rewritten = rewritten.replace(
      new RegExp(`ws://${escapedTargetHost}`, 'g'),
      proxyWebSocketOrigin
    );

    // 处理协议相对 URL: //anyrouter.top -> //any.chaosyn.com
    rewritten = rewritten.replace(
      new RegExp(`//${escapedTargetHost}(?![\\w])`, 'g'),
      `//${new URL(proxyUrl).hostname}`
    );

    return rewritten;
  } catch (error) {
    // 如果重写失败，返回原始内容
    console.error('URL 重写失败:', error);
    return content;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TARGET_HOST,
    TARGET_URL,
    buildProxyRequestHeaders,
    buildProxyResponseHeaders,
    getMimeType,
    handleRequest,
    isStreamingResponse,
    isTextContentType,
    isWebSocketRequest,
    rewriteRedirectLocation,
    rewriteUrlsInContent
  };
}
