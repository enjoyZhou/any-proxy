# Any-Proxy

基于 Cloudflare Worker 的通用反向代理工具。

## 功能特点

- **反向代理任意网站** - 只需修改 `TARGET_HOST` 变量即可代理任何目标网站
- **CDN 加速** - 利用 Cloudflare 全球节点加速访问
- **备案绕过** - 通过 Cloudflare 节点访问，无需国内服务器备案
- **自动 URL 重写** - 自动重写 HTML/CSS/JS 中的绝对 URL，确保资源正确加载
- **CORS 支持** - 自动处理跨域问题
- **完整请求转发** - 支持 GET/POST/PUT/DELETE 等所有 HTTP 方法
- **长连接代理** - 支持 WebSocket Upgrade、SSE 和常见流式响应透传

## 使用方法

### 1. 部署到 Cloudflare Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 `Workers & Pages` 页面
3. 点击 `Create Worker` 创建新的 Worker
4. 将 `worker.js` 中的代码粘贴到编辑器中
5. 点击 `Save and Deploy` 保存并部署

### 2. 配置目标网站

修改 `worker.js` 顶部的目标地址：

```javascript
// 目标网站地址
const TARGET_HOST = 'example.com';  // 修改为你要代理的网站域名
const TARGET_URL = `https://${TARGET_HOST}`;
```

### 3. 绑定自定义域名（可选）

1. 在 Worker 设置中点击 `Triggers`
2. 添加自定义域名（需要域名已托管在 Cloudflare）
3. 通过自定义域名访问代理服务

## 注意事项

- 请遵守相关法律法规，合理使用代理服务
- 部分网站可能有反代理检测，可能无法正常访问
- 建议仅用于个人学习和合法用途

## 技术文档

项目实现细节、请求处理流程、部署配置和维护建议见 [docs/TECHNICAL.md](docs/TECHNICAL.md)。

## 详细教程

更多详细配置和使用说明，请参考我的博客教程：

[Cloudflare Worker 反向代理网站教程](https://blog.chaosyn.com/posts/cloudflare-worker%E5%8F%8D%E5%90%91%E4%BB%A3%E7%90%86%E7%BD%91%E7%AB%99%E6%95%99%E7%A8%8B/)
