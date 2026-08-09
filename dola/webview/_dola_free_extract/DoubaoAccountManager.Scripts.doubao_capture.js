(function () {
    if (window.__doubaoCaptorLoaded) return;
    window.__doubaoCaptorLoaded = true;

    var sentUrls = new Set();

    // ========== 通过 Performance API 获取传输大小 ==========
    function getTransferSize(url) {
        var entries = performance.getEntriesByName(url);
        if (entries.length > 0 && entries[0].transferSize > 0) {
            return entries[0].transferSize;
        }
        var baseUrl = url.split('?')[0];
        var all = performance.getEntriesByType('resource');
        for (var i = 0; i < all.length; i++) {
            if (all[i].name.split('?')[0] === baseUrl && all[i].transferSize > 0) {
                return all[i].transferSize;
            }
        }
        return -1;
    }

    // ========== 水印检测 ==========
    function isWatermarked(url) {
        if (!url) return true;
        if (url.indexOf('watermark') !== -1) return true;
        if (url.indexOf('wm_') !== -1) return true;
        if (url.indexOf('_wm') !== -1) return true;
        return false;
    }

    // ========== 从 xg-poster 提取封面 URL ==========
    function extractPosterFromXgPoster(container) {
        if (!container) return '';
        var xgPoster = container.querySelector('xg-poster');
        if (!xgPoster) return '';
        var style = xgPoster.getAttribute('style') || '';
        var match = style.match(/background-image:\s*url\(([^)]+)\)/);
        if (match) {
            var url = match[1].replace(/^["']|["']$/g, '').trim();
            return url;
        }
        return '';
    }

    // ========== 查找封面（多来源，优先用可见的 cover img） ==========
    function findCoverUrl(container) {
        // 1. 优先：img 封面（class 含 cover，用户指明此路径）
        var coverImg = container.querySelector('img[class*="cover"], img[class*="poster"], .cover-u1rIsU');
        if (coverImg && coverImg.src) return coverImg.src;
        // 2. xg-poster 的 background-image
        var fromPoster = extractPosterFromXgPoster(container);
        if (fromPoster) return fromPoster;
        // 3. video 的 poster 属性
        var video = container.querySelector('video');
        if (video && video.poster) return video.poster;
        // 4. 任意 div 的 background-image
        var divs = container.querySelectorAll('[style*="background-image"]');
        for (var d = 0; d < divs.length; d++) {
            var st = divs[d].getAttribute('style') || '';
            var m = st.match(/background-image:\s*url\(([^)]+)\)/);
            if (m) return m[1].replace(/^["']|["']$/g, '').trim();
        }
        return '';
    }

    function isAiImage(img) {
        var src = img.src;
        if (!src || src.indexOf('rc_gen_image') === -1) return false;
        if (src.indexOf('avatar') !== -1) return false;
        if (src.indexOf('thumb') !== -1 || src.indexOf('thumbnail') !== -1) return false;
        if (!img.complete || img.naturalWidth < 200) return false;
        if (isWatermarked(src)) return false;
        // 传输体积 < 100KB → 缩略图
        var size = getTransferSize(src);
        if (size >= 0 && size < 102400) return false;
        return true;
    }

    function sendResource(data) {
        if (sentUrls.has(data.url)) return;
        sentUrls.add(data.url);
        if (!data.coverUrl && data.type === 'image') {
            data.coverUrl = data.url;
        }
        if (window.chrome && window.chrome.webview) {
            window.chrome.webview.postMessage({ type: 'newResource', data: data });
        }
    }

    function scanImages() {
        var imgs = document.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) {
            var img = imgs[i];
            if (!isAiImage(img)) continue;
            var prompt = '豆包图片';
            var card = img.closest('[class*="card"], [class*="message"], [class*="chat"]');
            if (card) {
                var promptEl = card.querySelector('[class*="prompt"], [class*="query"], [class*="question"]');
                if (promptEl) prompt = promptEl.textContent.trim().substring(0, 50);
            }
            sendResource({
                url: img.src,
                width: img.naturalWidth,
                height: img.naturalHeight,
                type: 'image',
                prompt: prompt,
                coverUrl: img.src
            });
        }
    }

    function scanVideos() {
        var containers = document.querySelectorAll('[class*="block-video"]');
        for (var i = 0; i < containers.length; i++) {
            var container = containers[i];
            var video = container.querySelector('video');
            if (!video) continue;

            var coverUrl = findCoverUrl(container);

            var prompt = '豆包视频';
            var msgRoot = container.closest('[data-message-id]');
            if (msgRoot) {
                var promptEl = msgRoot.querySelector('[class*="prompt"], [class*="query"]');
                if (promptEl) prompt = promptEl.textContent.trim().substring(0, 50);
            }

            var vid = '';
            if (video.src) {
                var vidMatch = video.src.match(/\/v0[a-zA-Z0-9_-]+/);
                if (vidMatch) vid = vidMatch[0].slice(1);
            }
            // 没拿到 vid 就不发送，等 videoDataExtracted 从 API 钩子来（避免重复）
            if (!vid) continue;

            sendResource({
                url: 'vid://' + vid,
                width: video.videoWidth || 0,
                height: video.videoHeight || 0,
                type: 'video',
                prompt: prompt,
                coverUrl: coverUrl,
                vid: vid
            });
        }
    }

    function startCapturing() {
        scanImages();
        scanVideos();

        var observer = new MutationObserver(function () {
            scanImages();
            scanVideos();
        });
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        } else {
            document.addEventListener('DOMContentLoaded', function () {
                observer.observe(document.body, { childList: true, subtree: true });
            });
        }

        setInterval(function () { scanImages(); scanVideos(); }, 3000);

        var lastUrl = location.href;
        setInterval(function () {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                setTimeout(function () { scanImages(); scanVideos(); }, 500);
            }
        }, 1000);
    }

    console.log('[ResourceCaptor] 豆包捕获启动（xg-poster封面 + 无水印过滤）');

    // 延迟启动，等 webview 就绪
    var retries = 0;
    function waitForWebview() {
        if (window.chrome && window.chrome.webview) {
            setTimeout(startCapturing, 1000);
            return;
        }
        retries++;
        if (retries < 30) {
            setTimeout(waitForWebview, 500);
        } else {
            console.error('[ResourceCaptor] webview 超时未就绪');
        }
    }
    waitForWebview();
})();
