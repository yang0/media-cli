(function () {
    if (window.__qianwenCaptorLoaded) return;
    window.__qianwenCaptorLoaded = true;

    var sentUrls = new Set();

    // ========== 通过 Performance API 获取图片传输大小 ==========
    function getTransferSize(url) {
        // 先精确匹配完整URL
        var entries = performance.getEntriesByName(url);
        if (entries.length > 0 && entries[0].transferSize > 0) {
            return entries[0].transferSize;
        }
        // 再按路径前缀匹配（去掉动态auth_key参数）
        var baseUrl = url.split('?')[0];
        var all = performance.getEntriesByType('resource');
        for (var i = 0; i < all.length; i++) {
            if (all[i].name.split('?')[0] === baseUrl && all[i].transferSize > 0) {
                return all[i].transferSize;
            }
        }
        return -1;
    }

    // ========== 判断是否为 AI 大图（非缩略图） ==========
    function isAiFullImage(img) {
        var src = img.src;
        if (!src) return false;
        if (src.indexOf('workspace-zb-cdn.qianwen.com') === -1) return false;
        // 必须有 data-image-resource-id（AI生成图专属标识）
        if (!img.getAttribute('data-image-resource-id')) return false;
        // 排除非AI容器
        if (img.closest('video')) return false;
        if (img.closest('.sidebar-GCLbjL, .imageItem-kyMXBq')) return false;
        if (img.closest('.chat-question-wrap, .question-text-card, .message-select-wrapper-question')) return false;
        if (img.closest('.fixed.left-0.top-0')) return false;
        if (img.closest('[class*="preview"], [class*="fullscreen"], [class*="viewer"]')) return false;
        // 必须在 AI 图片卡片内
        if (!img.closest('.imageItem-1LmyV')) return false;
        // 传输体积 < 500KB → 缩略图，跳过（大图 > 1MB）
        var size = getTransferSize(src);
        if (size >= 0 && size < 512000) return false;
        // 兜底：Performance API 拿不到时，按URL后缀过滤——只要.png原图，不要.webp.jpg预览
        if (size < 0 && src.indexOf('.webp.jpg') !== -1) return false;
        return true;
    }

    function isAiVideo(video) {
        var src = video.src;
        if (!src || src.indexOf('blob:') === 0) return false;
        return src.indexOf('workspace-zb-cdn.qianwen.com') !== -1 ||
               src.indexOf('qianwen.com') !== -1;
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

    function scanImages() {
        var imgs = document.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) {
            var img = imgs[i];
            if (!isAiFullImage(img)) continue;

            var prompt = '千问图片';
            var card = img.closest('.imageItem-1LmyV');
            if (card) {
                var msgArea = card.closest('[class*="message"], [class*="answer"], [class*="chat"]');
                if (msgArea) {
                    var questionEl = msgArea.querySelector('[class*="question"], [class*="query"], [class*="prompt"]');
                    if (!questionEl) {
                        var prevMsg = msgArea.previousElementSibling;
                        if (prevMsg) questionEl = prevMsg.querySelector('[class*="question"], [class*="query"]');
                    }
                    if (questionEl) prompt = questionEl.textContent.trim().substring(0, 50);
                }
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
        var videos = document.querySelectorAll('video');
        for (var i = 0; i < videos.length; i++) {
            var video = videos[i];
            if (!isAiVideo(video)) continue;

            var container = video.closest('.videoContainer-3A8Fk, .videoPlayerCard-1k1NX');
            if (!container) container = video.parentElement;

            var prompt = '千问视频';
            if (container) {
                var promptEl = container.querySelector('.title-35epL, .queryText-G_8y-, [class*="title"], [class*="prompt"]');
                if (promptEl) prompt = promptEl.textContent.trim().substring(0, 50);
            }

            var coverUrl = video.poster || '';
            sendResource({
                url: video.src,
                width: video.videoWidth || 0,
                height: video.videoHeight || 0,
                type: 'video',
                prompt: prompt,
                coverUrl: coverUrl
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
                sentUrls = new Set();
                setTimeout(function () { scanImages(); scanVideos(); }, 1000);
            }
        }, 1000);
    }

    console.log('[千问Capture] DOM扫描启动（仅 data-image-resource-id + >=400px 大图）');

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
            console.error('[千问Capture] webview 超时未就绪');
        }
    }
    waitForWebview();
})();
