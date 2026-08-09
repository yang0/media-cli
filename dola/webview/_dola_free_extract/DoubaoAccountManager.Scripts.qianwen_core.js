(function () {
    'use strict';

    console.log('[千问Core] WebView2 启动（API拦截 + 下载按钮）');

    // ========== 资源存储 ==========
    const cleanImageMap = new Map();     // resourceId -> { url, width, height }
    const processedImages = new WeakSet();
    const processedVideos = new WeakSet();

    function sendToHost(data) {
        if (window.chrome && window.chrome.webview) {
            window.chrome.webview.postMessage(data);
        }
    }

    // ========== 判断是否为有效图片（只要PNG原图，不要webp预览/缩略图） ==========
    function isValidImage(url, width, height) {
        if (!url) return false;
        // 只要 .png 原图，跳过 .webp.jpg 预览图和缩略图
        if (url.indexOf('.png') === -1) return false;
        if (url.indexOf('thumb') !== -1) return false;
        if ((width && width < 600) || (height && height < 600)) return false;
        return true;
    }

    // ========== 从 API 响应中提取 resource_infos ==========
    function extractResourceInfos(responseText) {
        const resources = [];
        try {
            const data = JSON.parse(responseText);
            const messages = data?.data?.list || [];

            for (const msg of messages) {
                const responseMsgs = msg?.response_messages || [];
                for (const rm of responseMsgs) {
                    const multiLoad = rm?.meta_data?.multi_load || [];
                    for (const ml of multiLoad) {
                        const html = ml?.html;
                        const toSearch = html?.sc_html || '';
                        const scriptMatch = toSearch.match(/<script[^>]*id="s-data-[^"]*"[^>]*>([\s\S]*?)<\/script>/);
                        if (scriptMatch) {
                            try {
                                const innerJson = JSON.parse(scriptMatch[1]);
                                const resourceInfos = innerJson?.data?.originalData?.content?.resource_infos;
                                if (resourceInfos && Array.isArray(resourceInfos)) {
                                    for (const ri of resourceInfos) {
                                        if (isValidImage(ri.url, ri.width, ri.height)) {
                                            resources.push({
                                                id: ri.id || '',
                                                url: ri.url,
                                                width: ri.width || 0,
                                                height: ri.height || 0
                                            });
                                        }
                                    }
                                }
                            } catch (e2) {}
                        }

                        const jsItems = html?.js || [];
                        for (const js of jsItems) {
                            if (js.name === 'hydrateData' && js.content) {
                                try {
                                    const innerJson = JSON.parse(js.content);
                                    const resourceInfos = innerJson?.data?.originalData?.content?.resource_infos;
                                    if (resourceInfos && Array.isArray(resourceInfos)) {
                                        for (const ri of resourceInfos) {
                                            if (isValidImage(ri.url, ri.width, ri.height) && !resources.find(r => r.id === ri.id)) {
                                                resources.push({
                                                    id: ri.id || '',
                                                    url: ri.url,
                                                    width: ri.width || 0,
                                                    height: ri.height || 0
                                                });
                                            }
                                        }
                                    }
                                } catch (e2) {}
                            }
                        }
                    }
                }
            }
        } catch (e) {}
        return resources;
    }

    // ========== API 劫持 ==========
    const origFetch = window.fetch;
    window.fetch = function () {
        var args = arguments;
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
        if (typeof url === 'string' && (url.indexOf('qianwen.com/api/v1/session/msg/list') !== -1 || url.indexOf('qianwen.com/api/v1/share/info') !== -1)) {
            return origFetch.apply(this, args).then(async function(resp) {
                const clone = resp.clone();
                try {
                    const text = await clone.text();
                    const resources = extractResourceInfos(text);
                    if (resources.length > 0) {
                        // 存入 cleanImageMap（按 resourceId）
                        for (const r of resources) {
                            if (r.id && !cleanImageMap.has(r.id)) {
                                cleanImageMap.set(r.id, {
                                    no_watermark_url: r.url,
                                    width: r.width,
                                    height: r.height
                                });
                            }
                        }
                        // 发送给 C# 用于右侧面板
                        const imageData = resources.map(function(r) {
                            return {
                                no_watermark_url: r.url,
                                width: r.width,
                                height: r.height,
                                coverUrl: r.url
                            };
                        });
                        sendToHost({ type: 'imageDataExtracted', data: imageData });
                        console.log('[千问Core] 提取到 ' + resources.length + ' 张无水印图片');
                    }
                } catch (e) {
                    console.warn('[千问Core] API解析失败:', e);
                }
                // 触发 DOM 重新扫描
                setTimeout(function() { scanImages(); scanVideos(); }, 500);
                return resp;
            });
        }
        return origFetch.apply(this, args);
    };

    // ========== 判断目标图片（与之前一致） ==========
    function isTargetImage(imgElement) {
        const src = imgElement.src;
        if (!src) return false;
        if (src.indexOf('workspace-zb-cdn.qianwen.com') === -1) return false;
        if (imgElement.closest('video')) return false;
        if (imgElement.closest('.sidebar-GCLbjL, .imageItem-kyMXBq')) return false;
        if (imgElement.closest('.chat-question-wrap, .question-text-card, .message-select-wrapper-question')) return false;
        if (imgElement.closest('.fixed.left-0.top-0')) return false;
        if (imgElement.closest('[class*="preview"], [class*="fullscreen"], [class*="viewer"]')) return false;
        const cardContainer = imgElement.closest('.imageItem-1LmyV');
        if (!cardContainer) return false;
        if (imgElement.naturalWidth < 100 || imgElement.naturalHeight < 100) return false;
        return true;
    }

    function isTargetVideo(videoElement) {
        const src = videoElement.src;
        if (!src || src.indexOf('blob:') === 0) return false;
        return src.indexOf('workspace-zb-cdn.qianwen.com') !== -1 || src.indexOf('qianwen.com') !== -1;
    }

    // ========== 下载按钮注入 ==========
    function injectImageButton(imgElement) {
        if (processedImages.has(imgElement)) return;
        if (!isTargetImage(imgElement)) return;

        let container = imgElement.closest('.imageItem-1LmyV');
        if (!container) return;
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
        if (container.querySelector('.qw-image-dl-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'qw-image-dl-btn';
        btn.textContent = '⬇ 下载图片';
        btn.style.cssText = 'position:absolute;bottom:10px;right:10px;z-index:9998;background:rgba(0,0,0,0.7);color:white;border:none;border-radius:20px;padding:6px 12px;font-size:12px;cursor:pointer;backdrop-filter:blur(4px);font-family:system-ui;transition:0.2s;';
        btn.addEventListener('mouseenter', function() { btn.style.background = 'rgba(0,0,0,0.9)'; });
        btn.addEventListener('mouseleave', function() { btn.style.background = 'rgba(0,0,0,0.7)'; });

        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            e.preventDefault();
            btn.disabled = true;
            btn.textContent = '下载中...';
            // 优先用 API 提取的无水印 URL
            const resourceId = imgElement.getAttribute('data-image-resource-id') || '';
            const cleanData = cleanImageMap.get(resourceId);
            const imgUrl = cleanData ? cleanData.no_watermark_url : imgElement.src;
            const filename = 'qianwen_image_' + Date.now() + '.png';
            sendToHost({ type: 'downloadFile', url: imgUrl, filename: filename });
            btn.textContent = '✓ 已请求';
            btn.style.background = '#10b981';
            setTimeout(function() {
                btn.textContent = '⬇ 下载图片';
                btn.style.background = 'rgba(0,0,0,0.7)';
                btn.disabled = false;
            }, 2000);
        });
        container.appendChild(btn);
        processedImages.add(imgElement);
    }

    function injectVideoButton(videoElement) {
        if (processedVideos.has(videoElement)) return;
        if (!isTargetVideo(videoElement)) return;

        let container = videoElement.closest('.videoContainer-3A8Fk, .videoPlayerCard-1k1NX');
        if (!container) container = videoElement.parentElement;
        if (!container) return;
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
        if (container.querySelector('.qw-video-dl-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'qw-video-dl-btn';
        btn.textContent = '⬇ 下载视频';
        btn.style.cssText = 'position:absolute;bottom:10px;right:10px;z-index:9998;background:rgba(0,0,0,0.7);color:white;border:none;border-radius:20px;padding:6px 12px;font-size:12px;cursor:pointer;backdrop-filter:blur(4px);font-family:system-ui;transition:0.2s;';
        btn.addEventListener('mouseenter', function() { btn.style.background = 'rgba(0,0,0,0.9)'; });
        btn.addEventListener('mouseleave', function() { btn.style.background = 'rgba(0,0,0,0.7)'; });

        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            e.preventDefault();
            btn.disabled = true;
            btn.textContent = '获取链接...';
            const videoUrl = videoElement.src;
            if (!videoUrl) {
                btn.textContent = '无地址';
                setTimeout(function() { btn.textContent = '⬇ 下载视频'; btn.disabled = false; }, 2000);
                return;
            }
            const filename = 'qianwen_video_' + Date.now() + '.mp4';
            sendToHost({ type: 'downloadFile', url: videoUrl, filename: filename });
            btn.textContent = '✓ 已请求';
            btn.style.background = '#10b981';
            setTimeout(function() {
                btn.textContent = '⬇ 下载视频';
                btn.style.background = 'rgba(0,0,0,0.7)';
                btn.disabled = false;
            }, 2000);
        });
        container.appendChild(btn);
        processedVideos.add(videoElement);
    }

    // ========== DOM 扫描 ==========
    function scanImages() {
        document.querySelectorAll('img').forEach(function(img) {
            if (img.src && img.src.indexOf('data:') !== 0 && !processedImages.has(img)) {
                if (img.complete) injectImageButton(img);
                else img.addEventListener('load', function() { injectImageButton(img); }, { once: true });
            }
        });
    }

    function scanVideos() {
        document.querySelectorAll('video').forEach(function(v) {
            if (v.src && v.src.indexOf('blob:') !== 0 && !processedVideos.has(v)) {
                injectVideoButton(v);
            }
        });
    }

    // ========== 初始化 ==========
    function init() {
        setTimeout(function() { scanImages(); scanVideos(); }, 1500);

        const observer = new MutationObserver(function() {
            scanImages();
            scanVideos();
        });
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        } else {
            document.addEventListener('DOMContentLoaded', function() {
                observer.observe(document.body, { childList: true, subtree: true });
            });
        }

        setInterval(function() { scanImages(); scanVideos(); }, 5000);
        console.log('[千问Core] 初始化完成');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
