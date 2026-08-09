(function () {
    if (window.__dolaCaptorLoaded) return;
    window.__dolaCaptorLoaded = true;

    console.log('[DolaCapture] Dola 资源捕获启动');

    var sentUrls = new Set();

    function findCoverUrl(container) {
        if (!container) return '';
        // 1. img 封面
        var coverImg = container.querySelector('img[class*="cover"], img[class*="poster"], img[class*="thumb"]');
        if (coverImg && coverImg.src && coverImg.src.indexOf('http') === 0) return coverImg.src;
        // 2. xg-poster background-image
        var xgPoster = container.querySelector('xg-poster');
        if (xgPoster) {
            var style = xgPoster.getAttribute('style') || '';
            var m = style.match(/background-image:\s*url\(([^)]+)\)/);
            if (m) return m[1].replace(/^["']|["']$/g, '').trim();
        }
        // 3. video poster
        var video = container.querySelector('video');
        if (video && video.poster && video.poster.indexOf('http') === 0) return video.poster;
        // 4. 任意 background-image
        var divs = container.querySelectorAll('[style*="background-image"]');
        for (var d = 0; d < divs.length; d++) {
            var st = divs[d].getAttribute('style') || '';
            var m2 = st.match(/background-image:\s*url\(([^)]+)\)/);
            if (m2) return m2[1].replace(/^["']|["']$/g, '').trim();
        }
        return '';
    }

    function sendResource(data) {
        if (!data.url || sentUrls.has(data.url)) return;
        sentUrls.add(data.url);
        if (!data.coverUrl && data.type === 'image') {
            data.coverUrl = data.url;
        }
        if (window.chrome && window.chrome.webview) {
            window.chrome.webview.postMessage({ type: 'newResource', data: data });
        }
    }

    // 完全按 dola_core.js 下载按钮逻辑：messageId → vid → resolveVideoUrl → 解码无水印URL
    function resolveVideoByMessageId(mid) {
        if (!mid) return null;
        var getVid = window.__dolaGetVidByMessageId;
        if (!getVid) return null;
        var vid = getVid(mid);
        if (!vid) return null;

        // 跟下载按钮完全一样的路径：resolveVideoUrl（缓存 → get_play_info → decode → 无水印 → 评分）
        var resolveFn = window.__dolaResolveVideoUrl;
        if (resolveFn) {
            var result = resolveFn(vid);
            if (result && result.mainUrl && result.mainUrl.indexOf('http') === 0) {
                return { url: result.mainUrl, width: result.width, height: result.height, vid: vid };
            }
        }
        return null;
    }

    function scanImages() {
        var imgs = document.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) {
            var img = imgs[i];
            var src = img.src;
            if (!src || src.indexOf('http') !== 0) continue;
            if (!img.complete || img.naturalWidth < 100) continue;

            // 只捕获 dola_core.js 已匹配到无水印地址的 AI 图片
            var findFn = window.__dolaFindImageData;
            var data = findFn ? findFn(src) : null;
            if (!data || !data.no_watermark_url) continue;

            var prompt = 'Dola图片';
            var card = img.closest('[class*="card"], [class*="message"], [class*="creation"]');
            if (card) {
                var promptEl = card.querySelector('[class*="prompt"], [class*="query"], [class*="question"]');
                if (promptEl) prompt = promptEl.textContent.trim().substring(0, 50);
            }

            sendResource({
                url: data.no_watermark_url,
                width: data.width || img.naturalWidth,
                height: data.height || img.naturalHeight,
                type: 'image',
                prompt: prompt,
                coverUrl: src
            });
        }
    }

    function scanVideos() {
        // 策略1：遍历视频容器
        var containers = document.querySelectorAll('[class*="block-video"], [class*="video-block"], [class*="video_block"], [class*="VideoBlock"], [class*="video-container"], [class*="video-wrapper"]');
        for (var i = 0; i < containers.length; i++) {
            var container = containers[i];
            var video = container.querySelector('video');
            if (!video) continue;

            var coverUrl = findCoverUrl(container);
            var prompt = 'Dola视频';
            var mid = '';
            var msgRoot = container.closest('[data-message-id]');
            if (msgRoot) {
                mid = msgRoot.getAttribute('data-message-id') || '';
                var promptEl = msgRoot.querySelector('[class*="prompt"], [class*="query"]');
                if (promptEl) prompt = promptEl.textContent.trim().substring(0, 50);
            }

            var domVid = '';
            if (video.src) {
                var vm = video.src.match(/\/v0[a-zA-Z0-9_-]+/);
                if (vm) domVid = vm[0].slice(1);
            }

            var resolved = resolveVideoByMessageId(mid);
            var vid = (resolved && resolved.vid) || domVid;
            var downloadUrl = resolved ? resolved.url : '';

            if (!downloadUrl) continue; // 解析不到真实地址就不捕获

            sendResource({
                url: downloadUrl,
                width: (resolved && resolved.width) || video.videoWidth || 0,
                height: (resolved && resolved.height) || video.videoHeight || 0,
                type: 'video',
                prompt: prompt,
                coverUrl: coverUrl,
                vid: vid
            });
        }

        // 策略2：独立 video 元素
        var videos = document.querySelectorAll('video');
        for (var v = 0; v < videos.length; v++) {
            var video2 = videos[v];
            if (!video2.src || video2.src.indexOf('blob:') === 0) continue;
            if (video2.closest('[class*="block-video"], [class*="video-block"], [class*="VideoBlock"]')) continue;

            var container2 = video2.parentElement;
            for (var d = 0; d < 6 && container2 && container2 !== document.body; d++) {
                var rect = container2.getBoundingClientRect();
                if (rect.width >= 100 && rect.height >= 80) break;
                container2 = container2.parentElement;
            }
            if (!container2) container2 = video2.parentElement;

            var coverUrl2 = video2.poster || findCoverUrl(container2);
            var mid2 = '';
            var msgRoot2 = container2.closest('[data-message-id]');
            if (msgRoot2) { mid2 = msgRoot2.getAttribute('data-message-id') || ''; }

            var domVid2 = '';
            if (video2.src) {
                var vm2 = video2.src.match(/\/v0[a-zA-Z0-9_-]+/);
                if (vm2) domVid2 = vm2[0].slice(1);
            }

            var resolved2 = resolveVideoByMessageId(mid2);
            var vid2 = (resolved2 && resolved2.vid) || domVid2;
            var downloadUrl2 = resolved2 ? resolved2.url : '';

            if (!downloadUrl2) continue; // 解析不到真实地址就不捕获

            sendResource({
                url: downloadUrl2,
                width: (resolved2 && resolved2.width) || video2.videoWidth || 0,
                height: (resolved2 && resolved2.height) || video2.videoHeight || 0,
                type: 'video',
                prompt: 'Dola视频',
                coverUrl: coverUrl2,
                vid: vid2
            });
        }
    }

    function start() {
        scanImages();
        scanVideos();
        setTimeout(function() { scanImages(); scanVideos(); }, 800);
        setTimeout(function() { scanImages(); scanVideos(); }, 2000);

        var observer = new MutationObserver(function () {
            scanImages();
            scanVideos();
        });
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'poster', 'data-message-id'] });
        } else {
            document.addEventListener('DOMContentLoaded', function () {
                observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'poster', 'data-message-id'] });
            });
        }

        setInterval(function () { scanImages(); scanVideos(); }, 3000);

        var lastUrl = location.href;
        setInterval(function () {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                sentUrls = new Set();
                if (window.chrome && window.chrome.webview) {
                    window.chrome.webview.postMessage({ type: 'pageChanged' });
                }
                setTimeout(function () { scanImages(); scanVideos(); }, 1000);
            }
        }, 1000);
    }

    var retries = 0;
    function waitForWebview() {
        if (window.chrome && window.chrome.webview) {
            setTimeout(start, 1000);
            return;
        }
        retries++;
        if (retries < 30) { setTimeout(waitForWebview, 500); }
        else { console.error('[DolaCapture] webview 超时未就绪'); }
    }
    waitForWebview();
})();
