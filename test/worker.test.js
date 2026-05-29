const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TARGET_URL,
  buildProxyRequestHeaders,
  handleRequest,
  isTextContentType,
  rewriteRedirectLocation,
  rewriteUrlsInContent
} = require('../worker.js');

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

test.beforeEach(() => {
  console.log = () => {};
  console.error = () => {};
});

test.afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

function createStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}

async function withMockedFetch(mockFetch, run) {
  const originalFetch = global.fetch;
  global.fetch = mockFetch;

  try {
    return await run();
  } finally {
    global.fetch = originalFetch;
  }
}

test('严格按 MIME 类型区分文本与二进制内容', () => {
  assert.equal(isTextContentType('text/html; charset=utf-8'), true);
  assert.equal(isTextContentType('application/json'), true);
  assert.equal(isTextContentType('application/problem+json'), true);
  assert.equal(isTextContentType('application/rss+xml'), true);
  assert.equal(isTextContentType('image/svg+xml'), true);

  assert.equal(isTextContentType('text/event-stream'), false);
  assert.equal(isTextContentType('font/woff2'), false);
  assert.equal(isTextContentType('application/x-font-ttf'), false);
  assert.equal(isTextContentType('application/vnd.ms-fontobject'), false);
  assert.equal(isTextContentType('image/png'), false);
  assert.equal(isTextContentType('application/octet-stream'), false);
});

test('URL 构造保留路径、查询参数和 HTTP 方法', async () => {
  let capturedUrl;
  let capturedOptions;

  await withMockedFetch(async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response('binary', {
      headers: {
        'Content-Type': 'application/octet-stream'
      }
    });
  }, async () => {
    const response = await handleRequest(new Request('https://proxy.example.com/api/users?q=abc&n=1'));

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, `${TARGET_URL}/api/users?q=abc&n=1`);
    assert.equal(capturedOptions.method, 'GET');
    assert.equal(capturedOptions.redirect, 'manual');
  });
});

test('请求头改写会调整 Host、Origin、Referer 并清理 hop-by-hop headers', () => {
  const request = new Request('https://proxy.example.com/path?x=1#hash', {
    headers: {
      Connection: 'keep-alive',
      Host: 'proxy.example.com',
      Origin: 'https://proxy.example.com',
      Referer: 'https://proxy.example.com/from?next=1#section',
      Upgrade: 'h2c'
    }
  });

  const headers = buildProxyRequestHeaders(request, new URL(request.url));

  assert.equal(headers.get('Host'), 'anyrouter.top');
  assert.equal(headers.get('Origin'), TARGET_URL);
  assert.equal(headers.get('Referer'), `${TARGET_URL}/from?next=1#section`);
  assert.equal(headers.has('Connection'), false);
  assert.equal(headers.has('Upgrade'), false);
});

test('重定向处理会改写目标站点同源 Location 并保留外部 Location', () => {
  assert.equal(
    rewriteRedirectLocation('/login?next=%2Fdashboard', 'https://proxy.example.com/start'),
    'https://proxy.example.com/login?next=%2Fdashboard'
  );

  assert.equal(
    rewriteRedirectLocation('https://anyrouter.top/account#profile', 'https://proxy.example.com/start'),
    'https://proxy.example.com/account#profile'
  );

  assert.equal(
    rewriteRedirectLocation('https://accounts.example.com/login', 'https://proxy.example.com/start'),
    'https://accounts.example.com/login'
  );
});

test('代理响应中的重定向 Location 会在 handleRequest 中改写', async () => {
  await withMockedFetch(async () => new Response(null, {
    status: 302,
    headers: {
      Location: '/login?next=%2F',
      'Content-Type': 'text/plain'
    }
  }), async () => {
    const response = await handleRequest(new Request('https://proxy.example.com/private', {
      headers: {
        Origin: 'https://app.example.com'
      }
    }));

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), 'https://proxy.example.com/login?next=%2F');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://app.example.com');
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
  });
});

test('URL 重写覆盖 HTTP、协议相对和 WebSocket 绝对地址', () => {
  const rewritten = rewriteUrlsInContent(
    [
      'https://anyrouter.top/assets/app.js',
      'http://anyrouter.top/api',
      '//anyrouter.top/cdn.css',
      'wss://anyrouter.top/socket',
      'ws://anyrouter.top/events'
    ].join('\n'),
    'https://proxy.example.com/page',
    TARGET_URL
  );

  assert.match(rewritten, /https:\/\/proxy\.example\.com\/assets\/app\.js/);
  assert.match(rewritten, /https:\/\/proxy\.example\.com\/api/);
  assert.match(rewritten, /\/\/proxy\.example\.com\/cdn\.css/);
  assert.match(rewritten, /wss:\/\/proxy\.example\.com\/socket/);
  assert.match(rewritten, /wss:\/\/proxy\.example\.com\/events/);
});

test('SSE 响应保持流式透传且不会调用 response.text()', async () => {
  let capturedOptions;

  await withMockedFetch(async (url, options) => {
    capturedOptions = options;
    return {
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'Content-Type': 'text/event-stream',
        'Content-Length': '999'
      }),
      body: createStream('data: ok\n\n'),
      text() {
        throw new Error('SSE response should not be buffered');
      }
    };
  }, async () => {
    const response = await handleRequest(new Request('https://proxy.example.com/events', {
      headers: {
        Accept: 'text/event-stream'
      }
    }));

    assert.equal(capturedOptions.headers.get('Accept-Encoding'), 'identity');
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
    assert.equal(response.headers.get('Content-Length'), null);
    assert.equal(response.headers.get('Cache-Control'), 'no-cache, no-transform');
    assert.equal(await response.text(), 'data: ok\n\n');
  });
});

test('WebSocket 握手会提前分流并透传 response.webSocket', async () => {
  const fakeWebSocketResponse = {
    status: 101,
    statusText: 'Switching Protocols',
    headers: new Headers(),
    body: null,
    webSocket: {}
  };
  let capturedUrl;
  let capturedOptions;

  await withMockedFetch(async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return fakeWebSocketResponse;
  }, async () => {
    const response = await handleRequest(new Request('https://proxy.example.com/realtime?token=abc', {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'test-key',
        'Sec-WebSocket-Version': '13'
      }
    }));

    assert.equal(response, fakeWebSocketResponse);
    assert.equal(capturedUrl, `${TARGET_URL}/realtime?token=abc`);
    assert.equal(capturedOptions.method, 'GET');
    assert.equal(capturedOptions.headers.get('Upgrade'), 'websocket');
    assert.equal(capturedOptions.headers.has('Connection'), false);
    assert.equal(capturedOptions.headers.has('Sec-WebSocket-Key'), false);
    assert.equal(capturedOptions.headers.has('Sec-WebSocket-Version'), false);
  });
});
