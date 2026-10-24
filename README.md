# 阿波罗音乐 · 代理服务（Cloudflare Pages）

基于 [mky-proxy](https://github.com/monkey2582/mky-proxy)（MIT）改造。**转发与缓存逻辑原样保留**，只动了密钥来源、域名白名单和品牌。

```
server-cf/
├── functions/api.js    代理本体，路由 /api
├── index.html          自测页，浏览器打开即可验活
└── README.md
```

## 相对原版改了什么

| 项 | 原版 | 现在 |
|---|---|---|
| 密钥 | 写死在 `functions/api.js` | 可用环境变量 `APOLLO_PROXY_KEY` 覆盖，代码里只留占位符 |
| 域名 | 放行所有域名（通用代理） | 默认只放行音乐上游；`APOLLO_ALLOW_ALL=1` 可恢复通用 |
| 白名单扩展 | 无 | `APOLLO_ALLOW_HOSTS=a.com,*.b.com` |
| 品牌 | mky-proxy | 阿波罗音乐 |

**没动的**：三层缓存、按接口分级的 TTL、`X-Proxy-Cache` 标记、`X-Proxy-Key` 请求头、POST 静默回退 GET、Referer 伪装、12MB 体积上限、流式转发、只缓存成功响应。

## 部署

### 1. 建仓库

把这四个文件推到你的 GitHub 仓库（Fork 原仓库再替换也行）。

### 2. 设密钥

**推荐**：Cloudflare Pages 项目 → Settings → Environment variables → 添加

```
APOLLO_PROXY_KEY = ap_你的随机串
```

生成一个：

```bash
echo "ap_$(openssl rand -hex 16)"
```

**或者**直接改 `functions/api.js` 第 33 行：

```js
const AUTH_KEY = 'ap_你的随机串';
```

> 环境变量优先于代码里的常量。两者都没改的话，默认值是 `CHANGE_ME_before_deploy` —— 等于没锁。

### 3. 连 Cloudflare Pages

Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**，选仓库。

| 字段 | 值 |
|---|---|
| Framework preset | None |
| Build command | *留空* |
| Build output directory | *留空* |

**必须留空**。没有构建步骤，Cloudflare 会把 `functions/` 编译成 Functions，根目录当静态资源发布。

### 4. 部署并验证

部署完成后访问 `https://<项目名>.pages.dev`，应该看到自测页。填入密钥和歌词地址，点「开始测试」，出现 `✓ 转发成功` 即通。

前端配置填：

```js
proxyApi: 'https://<项目名>.pages.dev/api',
proxyKey: 'ap_你的随机串'
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `APOLLO_PROXY_KEY` | 代码里的 `AUTH_KEY` | 访问密钥 |
| `APOLLO_ALLOW_ALL` | 空 | 设为 `1` 时关闭白名单，恢复通用代理 |
| `APOLLO_ALLOW_HOSTS` | 空 | 追加白名单，逗号分隔，支持 `*.example.com` |

默认白名单：

```
music.163.com  *.music.163.com  *.music.126.net
apis.netstart.cn  *.netstart.cn
music-api.gdstudio.xyz  node.api.xfabe.com  *.xfabe.com
```

## 接口

```
GET /api?key=<密钥>&url=<URL 编码的目标地址>
GET /api  + 请求头 X-Proxy-Key: <密钥>        ← 密钥不进 URL，更干净
```

| 状态 | 场景 | 响应 |
|---|---|---|
| 200 | 转发成功 | 上游原始响应 + `X-Proxy-Cache: HIT/MISS` |
| 400 | 缺 `url` / URL 非法 / 协议不是 http(s) | `{"error":"...","hint":"..."}` |
| 403 | 密钥错 | `{"error":"forbidden","hint":"missing or wrong key"}` |
| 403 | 域名不在白名单 | `{"error":"host not allowed","hint":"该域名不在白名单内：..."}` |
| 405 | 非 GET/POST/OPTIONS | `{"error":"method not allowed"}` |
| 413 | 响应超过 12MB | `{"error":"response too large"}` |
| 502 | 回源失败或超时 | `{"error":"upstream fetch failed","detail":"..."}` |

## 缓存策略（原版设计，别乱改）

| 内容 | TTL |
|---|---|
| `?types=pic` / `?types=lyric` | 7 天 |
| `suggest/keyword` | 1 天 |
| 图片（jpg/png/webp/gif/avif） | 7 天 |
| 搜索 | 30 分钟 |
| 其他（含播放地址） | 5 分钟 |

播放地址约 20 分钟过期，所以默认 5 分钟——既省请求，又远早于失效。

缓存键是**上游 URL**，不是代理 URL，所以换密钥不会让缓存全部失效。

## 为什么用 Pages 而不是 Worker

`*.workers.dev` 在国内被 DNS 污染（解析到 Facebook 的 IPv6 段），`*.pages.dev` 解析到真实 Cloudflare IP，国内可直连。这是原项目选 Pages 的唯一原因，本项目沿用。

## 两个必看的坑

**Direct Upload 不编译 Functions。** 用 API 直接上传文件的项目，`uses_functions` 恒为 false，即使 `functions/api.js` 在文件清单里。只有 Git 连接的项目才启用 Functions，且 Direct Upload 项目无法通过 API 转成 Git 项目。**所以必须走 Git 部署。**

**别用 Python 脚本测。** Cloudflare WAF 会把 `Python-urllib/3.x` 判为机器人返回 `403 error code: 1010`，这个 403 不是你的 Functions 返回的。测试时带浏览器 UA。

## 额度

| 项目 | 免费额度 |
|---|---|
| Functions 调用 | 10 万次/天（账号级共享） |
| 静态请求 | 无限 |
| 构建 | 500 次/月 |

按 UTC 0 点（北京时间 8 点）重置。一天听 1000 首 ≈ 用掉 1%。

## 许可

MIT。原项目版权归 [monkey2582](https://github.com/monkey2582) 所有，本改造同样以 MIT 发布。
