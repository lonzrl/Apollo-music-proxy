/**
 * 阿波罗音乐 · 代理服务（Cloudflare Pages Functions）
 *
 * 路由：/api?key=<密钥>&url=<编码后的目标地址>
 *
 * 本文件基于 mky-proxy（MIT，github.com/monkey2582/mky-proxy）的
 * functions/api.js 改造而来，核心转发与缓存逻辑保持原样。
 *
 * 相对原版的改动只有五处，其余一字未动：
 *   1. 密钥支持环境变量 APOLLO_PROXY_KEY 覆盖，不再只能改源码
 *   2. 新增上游域名白名单（默认只放行音乐接口），可用 APOLLO_ALLOW_ALL=1 关掉
 *   3. 支持 APOLLO_ALLOW_HOSTS 追加白名单域名
 *   4. 注释与品牌改为阿波罗音乐
 *   5. 跳转改为手动跟随，每一跳都校验白名单（否则白名单可被 302 绕过）
 *
 * 分三层省请求（原版设计，未改动）：
 *
 *   客户端  Cache-Control 长 TTL —— 重复请求压根到不了函数，这才是省额度的主力
 *   边缘层  Cache API 共享缓存 —— 挡住重复回源，主要用来避开上游的频率限制
 *   源站层  超时 / 体积上限 —— 防挂死、防爆内存
 *
 * 密钥仍然只是"止损开关"而非"安全机制"：它躺在 URL 里，会出现在浏览器历史、
 * 日志和 Referer 中。要更干净，客户端可以改用 X-Proxy-Key 请求头（这里已支持）。
 */

// 访问密钥。改这里就等于换锁。
// 推荐用 Cloudflare Pages 的环境变量 APOLLO_PROXY_KEY 覆盖本值（见 README），
// 这样密钥不落在代码里。生成一个：openssl rand -hex 16
const AUTH_KEY = 'CHANGE_ME_before_deploy';

// 上游域名白名单。原版是"通用代理"，刻意放行所有域名；
// 本项目只服务音乐播放器，默认收紧，防止服务被当成免费跳板。
// 需要恢复原版的通用行为：环境变量 APOLLO_ALLOW_ALL=1
const DEFAULT_ALLOW_HOSTS = [
    'music.163.com',
    '*.music.163.com',
    '*.music.126.net',      // 封面图与音频回源
    'apis.netstart.cn',
    '*.netstart.cn',
    'music-api.gdstudio.xyz',
    'node.api.xfabe.com',
    '*.xfabe.com'
];

const CORS_HEADERS = {
    // 允许任意来源：这个代理的定位就是"给不可控环境用"，
    // 播放器可能从 file:// 或任意域名打开。
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    // 让前端 JS 也能读到缓存命中标记，方便在 DevTools 里确认缓存是否生效。
    'Access-Control-Expose-Headers': 'X-Proxy-Cache',
    'Access-Control-Max-Age': '86400'
};

const UPSTREAM_TIMEOUT_MS = 12000;
const MAX_BYTES = 12 * 1024 * 1024;

// 按接口性质给缓存时长（秒）。播放地址有时效（网易云约 20 分钟），
// 所以走默认的 5 分钟 —— 既省请求，又远早于它过期。
function ttlFor(u) {
    const type = u.searchParams.get('types');
    if (type === 'pic') return 604800;
    if (type === 'lyric') return 604800;
    if (type === 'search') return 1800;
    if (u.pathname.indexOf('suggest/keyword') >= 0) return 86400;
    if (u.pathname.indexOf('/search') >= 0) return 1800;
    if (/\.(jpe?g|png|webp|gif|avif)$/i.test(u.pathname)) return 604800;
    return 300;
}

// 域名匹配：精确 或 *.suffix。与 Node / PHP 版保持同一套规则。
function hostAllowed(hostname, allowHosts) {
    const h = String(hostname || '').toLowerCase();
    if (!h) return false;
    for (const rule of allowHosts) {
        if (rule.indexOf('*.') === 0) {
            const base = rule.slice(2);
            if (h === base || h.slice(-(base.length + 1)) === '.' + base) return true;
        } else if (h === rule) {
            return true;
        }
    }
    return false;
}

// 缓存是"尽力而为"的装饰层，不是硬依赖：
// 拿不到 Cache API 就静默跳过，代理本身照常工作。
function safeCache() {
    try {
        return caches.default || null;
    } catch (_) {
        return null;
    }
}

export async function onRequest(context) {
    const req = context.request;
    const env = context.env || {};

    const authKey = env.APOLLO_PROXY_KEY || AUTH_KEY;
    const allowAll = String(env.APOLLO_ALLOW_ALL || '') === '1';
    const allowHosts = env.APOLLO_ALLOW_HOSTS
        ? String(env.APOLLO_ALLOW_HOSTS).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        : DEFAULT_ALLOW_HOSTS;

    // 预检请求不需要密钥：它不转发任何东西，放行不会造成消耗
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // POST 静默回退成 GET：目标地址完全由 url 参数决定，请求体不参与转发，
    // 所以方法本身不影响结果。为习惯用 POST 发只读请求的客户端报 405 只是添乱。
    if (req.method !== 'GET' && req.method !== 'POST') {
        return json({ error: 'method not allowed', allow: 'GET, POST, OPTIONS' }, 405);
    }

    const params = new URL(req.url).searchParams;

    // ---- 密钥校验 ----
    // 优先读请求头，兼容旧的 ?key= 形式。
    const key = req.headers.get('x-proxy-key') || params.get('key');
    if (!authKey || key !== authKey) {
        return json({ error: 'forbidden', hint: 'missing or wrong key' }, 403);
    }

    const target = params.get('url');
    if (!target) {
        return json({
            error: 'missing url param',
            usage: '/api?key=<key>&url=<encoded target>'
        }, 400);
    }

    let targetUrl;
    try {
        targetUrl = new URL(target);
    } catch (_) {
        return json({ error: 'invalid url', got: target }, 400);
    }

    // 只允许 http/https：挡掉 file:、data: 这类协议。
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        return json({ error: 'protocol not allowed', got: targetUrl.protocol }, 400);
    }

    // ---- 域名白名单（新增）----
    if (!allowAll && !hostAllowed(targetUrl.hostname, allowHosts)) {
        return json({
            error: 'host not allowed',
            hint: '该域名不在白名单内：' + targetUrl.hostname
        }, 403);
    }

    const ttl = ttlFor(targetUrl);
    // 缓存键用"上游 URL"而不是"代理 URL" —— 这样密钥变了缓存依然有效，
    // 不同用户请求同一资源也能共享命中。
    const cacheKey = new Request(targetUrl.toString(), { method: 'GET' });
    const cache = safeCache();

    const hit = cache
        ? await cache.match(cacheKey).catch(function () { return null; })
        : null;
    if (hit) {
        const h = new Headers(hit.headers);
        h.set('X-Proxy-Cache', 'HIT');
        return new Response(hit.body, { status: hit.status, headers: h });
    }

    // 转发。Referer 伪装成目标站点自己，应对部分站点的防盗链检查。
    // 加超时：上游挂死时不能把函数一起拖住。
    //
    // 相对原版的一处收紧：原版用 redirect:'follow'，白名单只校验首个域名，
    // 一个 302 就能把请求带到任意站点。这里改成手动跟随，每一跳都重新校验。
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/120.0.0.0 Safari/537.36';
    const deadline = Date.now() + UPSTREAM_TIMEOUT_MS;

    let upstream;
    let current = targetUrl;
    try {
        for (let hop = 0; ; hop++) {
            upstream = await fetch(current.toString(), {
                method: 'GET',
                headers: {
                    'Referer': current.origin + '/',
                    'User-Agent': UA
                },
                redirect: 'manual',
                signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
            });

            const loc = (upstream.status >= 300 && upstream.status < 400)
                ? upstream.headers.get('Location')
                : null;
            if (!loc) break;

            if (hop >= 3) {
                try { await upstream.body.cancel(); } catch (_) {}
                return json({ error: 'too many redirects' }, 502);
            }

            let next;
            try {
                next = new URL(loc, current);
            } catch (_) {
                try { await upstream.body.cancel(); } catch (_) {}
                return json({ error: 'bad redirect' }, 502);
            }
            if (next.protocol !== 'http:' && next.protocol !== 'https:') {
                try { await upstream.body.cancel(); } catch (_) {}
                return json({ error: 'bad redirect' }, 502);
            }
            if (!allowAll && !hostAllowed(next.hostname, allowHosts)) {
                try { await upstream.body.cancel(); } catch (_) {}
                return json({ error: 'redirect host not allowed', hint: next.hostname }, 403);
            }

            try { await upstream.body.cancel(); } catch (_) {}
            current = next;
        }
    } catch (e) {
        return json({ error: 'upstream fetch failed', detail: String(e).slice(0, 200) }, 502);
    }

    // 体积上限。Content-Length 不总是存在，拿不到就交给流式转发。
    const size = Number(upstream.headers.get('Content-Length') || 0);
    if (size > MAX_BYTES) {
        return json({ error: 'response too large', size: size }, 413);
    }

    const headers = new Headers(CORS_HEADERS);
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');

    // 只缓存成功的响应。把 4xx/5xx 缓存 5 分钟会让故障"粘住"，
    // 上游一恢复用户却还在看旧错误。
    const cacheable = upstream.ok;
    headers.set('X-Proxy-Cache', cacheable ? 'MISS' : 'BYPASS');
    headers.set('Cache-Control', cacheable
        ? 'public, max-age=' + ttl + ', stale-while-revalidate=' + ttl
        : 'no-store');

    const res = new Response(upstream.body, { status: upstream.status, headers });

    // 放到后台写缓存，别让用户等它写完。
    // waitUntil 缺失（或缓存层不可用）时直接放弃写入，不影响这次响应。
    if (cacheable && cache && typeof context.waitUntil === 'function') {
        context.waitUntil(
            cache.put(cacheKey, res.clone()).catch(function () {})
        );
    }

    return res;
}

function json(obj, status) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store'
        }
    });
}
