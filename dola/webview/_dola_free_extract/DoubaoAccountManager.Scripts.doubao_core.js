(function () {
    'use strict';

    // ==================== 状态 ====================
    const imageDataMap = new Map();          // 图片: key -> { no_watermark_url, width, height }
    const messageVideoMap = new Map();       // 视频: messageId -> [vid1, vid2, ...]
    const vidCoverMap = new Map();           // 封面: vid -> coverUrl（从 video_model.poster_url 提取）
    const vidImageNameMap = new Map();       // vid -> 对应上传图片名
    const processedImages = new WeakSet();
    const processedContainers = new WeakSet();
    let domObserverActive = false;

    function sendToHost(data) {
        if (window.chrome && window.chrome.webview) {
            window.chrome.webview.postMessage(data);
            console.log('[Core] 发送消息:', data);
        } else {
            console.warn('[Core] chrome.webview 不可用');
        }
    }

    // ==================== 从 xg-poster 提取封面 URL ====================
    function extractPosterFromXgPoster(container) {
        if (!container) return '';
        const xgPoster = container.querySelector('xg-poster');
        if (!xgPoster) return '';
        const style = xgPoster.getAttribute('style') || '';
        const match = style.match(/background-image:\s*url\(([^)]+)\)/);
        if (match) {
            let url = match[1].replace(/^["']|["']$/g, '').trim();
            return url;
        }
        return '';
    }

    // ==================== 查找所有封面来源 ====================
    function findCoverUrl(container) {
        // 1. 优先：cover img
        const coverImg = container.querySelector('img[class*="cover"], img[class*="poster"], .cover-u1rIsU');
        if (coverImg && coverImg.src) return coverImg.src;
        // 2. xg-poster background-image
        let coverUrl = extractPosterFromXgPoster(container);
        if (coverUrl) return coverUrl;
        // 3. video poster 属性
        const video = container.querySelector('video');
        if (video && video.poster) return video.poster;
        return '';
    }

    // ==================== 提取 vid ====================
    function findAllVidsInObject(obj, depth) {
        depth = depth || 0;
        const vids = [];
        if (depth > 15 || !obj) return vids;
        if (Array.isArray(obj)) {
            for (const item of obj) {
                vids.push(...findAllVidsInObject(item, depth + 1));
            }
        } else if (typeof obj === "object") {
            const directVid = obj.vid || obj.video_id;
            if (directVid && typeof directVid === "string" && directVid.startsWith("v0")) {
                vids.push(directVid);
            }
            if (obj.creations && Array.isArray(obj.creations)) {
                for (const creation of obj.creations) {
                    const imgVid = creation?.image?.video?.vid || creation?.video?.vid;
                    if (imgVid && typeof imgVid === "string" && imgVid.startsWith("v0")) {
                        vids.push(imgVid);
                    }
                }
            }
            for (const val of Object.values(obj)) {
                if (typeof val === "string") {
                    const match = val.match(/\/v0[a-zA-Z0-9_-]+/);
                    if (match && match[0].startsWith("/v0")) {
                        const vid = match[0].slice(1);
                        if (vid.startsWith("v0") && !vids.includes(vid)) vids.push(vid);
                    }
                }
                vids.push(...findAllVidsInObject(val, depth + 1));
            }
        }
        return [...new Map(vids.map(function(v) { return [v, v]; })).values()];
    }

    function extractFileKey(url) {
        if (!url) return null;
        const match = url.match(/rc_gen_image\/([^?~]+)/);
        return match ? match[1] : null;
    }

    // ==================== 解析 video_model JSON 字符串提取 poster_url ====================
    function extractVideoCover(creation) {
        // 优先从 video_model 里取 poster_url（无水印封面）
        try {
            const videoModelStr = creation?.video?.video_model;
            if (videoModelStr && typeof videoModelStr === 'string') {
                const model = JSON.parse(videoModelStr);
                if (model && model.poster_url) {
                    return model.poster_url;
                }
            }
        } catch (e) {}
        // 备用：video.cover.image_thumb.url
        try {
            const thumbUrl = creation?.video?.cover?.image_thumb?.url;
            if (thumbUrl) return thumbUrl;
        } catch (e) {}
        return '';
    }

    function updateMapsFromMessages(messages) {
        // 第一遍：收集用户消息里上传的图片名数组（按顺序）
        var uploadedImageNames = [];
        for (const msg of messages) {
            if (msg.sender_id && msg.user_type === 1) { // 用户消息
                for (const block of msg?.content_block || []) {
                    var atts = block?.content?.attachment_block?.attachments;
                    if (atts && Array.isArray(atts)) {
                        for (const att of atts) {
                            var name = att?.image?.name;
                            if (name) uploadedImageNames.push(name.replace(/\.[^.]+$/, ''));
                        }
                    }
                }
            }
        }

        for (const msg of messages) {
            const msgId = String(msg.message_id || "").trim();
            if (!msgId || msgId === "0") continue;

            const vids = findAllVidsInObject(msg);
            if (vids.length) {
                const existing = messageVideoMap.get(msgId);
                if (!existing || existing.join(',') !== vids.join(',')) {
                    messageVideoMap.set(msgId, vids);
                    console.log('[Core] 更新消息 ' + msgId + ' 的视频:', vids);
                }
            }

            // 提取 creations 中的视频封面和图片数据
            var creationIndex = 0;
            for (const block of msg?.content_block || []) {
                const creations = block?.content?.creation_block?.creations;
                if (!creations) continue;

                for (const cr of creations) {
                    // ===== 视频：解析 video_model 拿 poster_url + 绑定图片名 =====
                    if (cr?.video) {
                        const vid = cr.video.vid;
                        if (vid) {
                            const coverUrl = extractVideoCover(cr);
                            if (coverUrl && !vidCoverMap.has(vid)) {
                                vidCoverMap.set(vid, coverUrl);
                                console.log('[Core] 封面 ' + vid + ': ' + coverUrl.substring(0, 60) + '...');
                            }
                            // 绑定对应索引的图片名（失败视频 vid 为空自动跳过）
                            if (!vidImageNameMap.has(vid) && creationIndex < uploadedImageNames.length) {
                                var imgName = uploadedImageNames[creationIndex];
                                vidImageNameMap.set(vid, imgName);
                                console.log('[Core] 图片名绑定: ' + vid + ' → ' + imgName);
                            }
                        }
                        creationIndex++;
                    }

                    // ===== 图片：拿无水印原图 =====
                    const img = cr?.image;
                    // 1. 优先：image_ori_raw（无水印原图）
                    const raw = img?.image_ori_raw;
                    if (raw?.url) {
                        const key = extractFileKey(raw.url);
                        if (key) {
                            imageDataMap.set(key, {
                                no_watermark_url: raw.url,
                                width: raw.width || null,
                                height: raw.height || null
                            });
                        }
                    }
                    // 2. 备用：display_list 中的 image 类型（跳过 thumbnail）
                    const displayList = img?.display_list;
                    if (displayList && Array.isArray(displayList)) {
                        for (const item of displayList) {
                            if (item.type === 'image' && item.url) {
                                const dlKey = extractFileKey(item.url);
                                if (dlKey && !imageDataMap.has(dlKey)) {
                                    imageDataMap.set(dlKey, {
                                        no_watermark_url: item.url,
                                        width: item.width || null,
                                        height: item.height || null
                                    });
                                }
                            }
                            // 跳过 type === 'thumbnail'
                        }
                    }
                }
            }
        }
    }

    // ==================== 劫持 API 响应 ====================
    const origFetch = window.fetch;
    window.fetch = function () {
        var args = arguments;
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (typeof url === 'string' && url.includes('chain/single')) {
            return origFetch.apply(this, args).then(async function(resp) {
                const clone = resp.clone();
                try {
                    const data = await clone.json();
                    const messages = data?.downlink_body?.pull_singe_chain_downlink_body?.messages;
                    if (messages) {
                        updateMapsFromMessages(messages);

                        // 提取视频信息（优先用 API 里的 poster_url）
                        const allVideos = [];
                        for (const [msgId, vids] of messageVideoMap.entries()) {
                            for (const vid of vids) {
                                // 1. 优先从 API 提取的 vidCoverMap 拿（无水印封面）
                                let coverUrl = vidCoverMap.get(vid) || '';
                                // 2. 备用：从 DOM 找封面
                                if (!coverUrl) {
                                    try {
                                        const msgEl = document.querySelector('[data-message-id="' + msgId + '"]');
                                        if (msgEl) {
                                            coverUrl = findCoverUrl(msgEl);
                                        }
                                    } catch (e) {}
                                }
                                allVideos.push({ vid: vid, messageId: msgId, coverUrl: coverUrl });
                            }
                        }
                        if (allVideos.length) {
                            sendToHost({ type: 'videoDataExtracted', data: allVideos, imageNameMap: Object.fromEntries(vidImageNameMap) });
                        }
                        if (imageDataMap.size) {
                            const imageData = Array.from(imageDataMap.values()).map(function(item) {
                                return {
                                    no_watermark_url: item.no_watermark_url,
                                    width: item.width,
                                    height: item.height,
                                    coverUrl: item.no_watermark_url
                                };
                            });
                            sendToHost({ type: 'imageDataExtracted', data: imageData });
                        }
                    }
                } catch (e) { /* 忽略 */ }
                return resp;
            });
        }
        return origFetch.apply(this, args);
    };

    // XHR 劫持
    const origXHROpen = XMLHttpRequest.prototype.open;
    const origXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this._url = url;
        return origXHROpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
        var self = this;
        this.addEventListener('load', function() {
            if (self._url && self._url.includes('chain/single')) {
                try {
                    const data = JSON.parse(self.responseText);
                    const messages = data?.downlink_body?.pull_singe_chain_downlink_body?.messages;
                    if (messages) {
                        updateMapsFromMessages(messages);

                        // 提取视频信息（优先用 API 里的 poster_url）
                        const allVideos = [];
                        for (const [msgId, vids] of messageVideoMap.entries()) {
                            for (const vid of vids) {
                                let coverUrl = vidCoverMap.get(vid) || '';
                                if (!coverUrl) {
                                    try {
                                        const msgEl = document.querySelector('[data-message-id="' + msgId + '"]');
                                        if (msgEl) {
                                            coverUrl = findCoverUrl(msgEl);
                                        }
                                    } catch (e) {}
                                }
                                allVideos.push({ vid: vid, messageId: msgId, coverUrl: coverUrl });
                            }
                        }
                        if (allVideos.length) {
                            sendToHost({ type: 'videoDataExtracted', data: allVideos, imageNameMap: Object.fromEntries(vidImageNameMap) });
                        }
                        if (imageDataMap.size) {
                            const imageData = Array.from(imageDataMap.values()).map(function(item) {
                                return {
                                    no_watermark_url: item.no_watermark_url,
                                    width: item.width,
                                    height: item.height,
                                    coverUrl: item.no_watermark_url
                                };
                            });
                            sendToHost({ type: 'imageDataExtracted', data: imageData });
                        }
                    }
                } catch (e) { /* 忽略 */ }
            }
        });
        return origXHRSend.call(this, body);
    };

    // ==================== 注入下载按钮 ====================
    function injectImageButton(img) {
        if (processedImages.has(img)) return;
        const key = extractFileKey(img.src);
        if (!key) return;
        const data = imageDataMap.get(key);
        if (!data) return;

        let container = img.parentElement;
        for (let i = 0; i < 6 && container && container !== document.body; i++) {
            const rect = container.getBoundingClientRect();
            if (rect.width >= 100 && rect.height >= 80) break;
            container = container.parentElement;
        }
        if (!container) container = img.parentElement;
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
        if (container.querySelector('.core-dl-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'core-dl-btn';
        btn.textContent = '⬇ 下载图片';
        btn.style.cssText = 'position:absolute;bottom:10px;right:10px;z-index:9999;background:rgba(0,0,0,0.6);color:white;border:none;border-radius:20px;padding:6px 12px;font-size:12px;cursor:pointer;backdrop-filter:blur(4px);';
        btn.addEventListener('mouseenter', function() { btn.style.background = 'rgba(0,0,0,0.85)'; });
        btn.addEventListener('mouseleave', function() { btn.style.background = 'rgba(0,0,0,0.6)'; });

        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            e.preventDefault();
            btn.disabled = true;
            btn.textContent = '下载中...';
            sendToHost({ type: 'download', url: data.no_watermark_url, filename: 'image_' + Date.now() + '.png' });
            btn.textContent = '✓ 已请求';
            btn.style.background = '#10b981';
            setTimeout(function() {
                btn.disabled = false;
                btn.textContent = '⬇ 下载图片';
                btn.style.background = 'rgba(0,0,0,0.6)';
            }, 3000);
        });
        container.appendChild(btn);
        processedImages.add(img);
    }

    function findMessageId(element) {
        let el = element;
        for (let i = 0; i < 20 && el && el !== document.body; i++) {
            if (el.dataset) {
                if (el.dataset.messageId) return el.dataset.messageId;
                if (el.dataset.message_id) return el.dataset.message_id;
            }
            el = el.parentElement;
        }
        return null;
    }

    function getVideoIndexInMessage(container) {
        let msgRoot = container;
        for (let i = 0; i < 15 && msgRoot && msgRoot !== document.body; i++) {
            if (msgRoot.hasAttribute && msgRoot.hasAttribute('data-message-id')) break;
            msgRoot = msgRoot.parentElement;
        }
        if (!msgRoot || !msgRoot.hasAttribute('data-message-id')) return undefined;
        const siblings = Array.from(msgRoot.querySelectorAll('[class*="block-video"]'));
        const idx = siblings.indexOf(container);
        return idx === -1 ? undefined : idx;
    }

    // ===== 上传图片名（最新一次上传覆盖旧值，下载时消费） =====
    var uploadImageName = '';
    var uploadImageNames = []; // 本次批量上传的全量名字（失败时做兜底）

    try { uploadImageName = sessionStorage.getItem('doubao_upload_name') || ''; } catch(_) {}
    try { uploadImageNames = JSON.parse(sessionStorage.getItem('doubao_upload_names') || '[]'); } catch(_) {}

    document.addEventListener('change', function(e) {
        var input = e.target;
        if (input && input.tagName === 'INPUT' && input.type === 'file' && input.files && input.files.length > 0) {
            var accept = (input.accept || '').toLowerCase();
            if (accept.includes('.jpg') || accept.includes('.png') || accept.includes('.jpeg') || accept.includes('.webp') || accept === 'image/*') {
                uploadImageNames = [];
                for (var i = 0; i < input.files.length; i++) {
                    var n = input.files[i].name.replace(/\.[^.]+$/, '');
                    uploadImageNames.push(n);
                    if (i === 0) uploadImageName = n;
                }
                try { sessionStorage.setItem('doubao_upload_name', uploadImageName); } catch(_) {}
                try { sessionStorage.setItem('doubao_upload_names', JSON.stringify(uploadImageNames)); } catch(_) {}
                console.log('[Core] 上传: ' + uploadImageName + (uploadImageNames.length > 1 ? ' 等' + uploadImageNames.length + '张' : ''));
                sendToHost({ type: 'uploadImageName', name: uploadImageName });
            }
        }
    }, true);

    // 下载时：优先出队（批量场景），否则用最后上传名
    var downloadSeq = 0;
    function nextImageName() {
        if (uploadImageNames.length > 0) {
            var name = uploadImageNames.shift();
            try { sessionStorage.setItem('doubao_upload_names', JSON.stringify(uploadImageNames)); } catch(_) {}
            if (name) { console.log('[Core] 出队: ' + name); return name; }
        }
        // 兜底：上次名字
        return uploadImageName;
    }

    function injectVideoButton(container) {
        if (processedContainers.has(container)) return;
        const messageId = findMessageId(container);
        if (!messageId) return;
        const vids = messageVideoMap.get(messageId);
        if (!vids || vids.length === 0) return;

        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
        if (container.querySelector('.core-video-dl-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'core-video-dl-btn';
        btn.textContent = '⬇ 下载视频';
        btn.style.cssText = 'position:absolute;bottom:10px;right:10px;z-index:9999;background:rgba(0,0,0,0.6);color:white;border:none;border-radius:20px;padding:6px 12px;font-size:12px;cursor:pointer;backdrop-filter:blur(4px);';
        btn.addEventListener('mouseenter', function() { btn.style.background = 'rgba(0,0,0,0.85)'; });
        btn.addEventListener('mouseleave', function() { btn.style.background = 'rgba(0,0,0,0.6)'; });

        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            e.preventDefault();
            btn.disabled = true;
            btn.textContent = '获取链接...';
            const index = getVideoIndexInMessage(container);
            const targetVid = (index !== undefined && index < vids.length) ? vids[index] : vids[0];
            var name = vidImageNameMap.get(targetVid) || nextImageName();
            sendToHost({ type: 'downloadVideo', vid: targetVid, messageId: messageId, index: index, imageName: name });
            btn.textContent = '✓ 已请求';
            btn.style.background = '#10b981';
            setTimeout(function() {
                btn.disabled = false;
                btn.textContent = '⬇ 下载视频';
                btn.style.background = 'rgba(0,0,0,0.6)';
            }, 3000);
        });
        container.appendChild(btn);
        processedContainers.add(container);
    }

    function scanImages() {
        document.querySelectorAll('img').forEach(function(img) {
            if (img.src && img.complete) {
                injectImageButton(img);
            } else {
                img.addEventListener('load', function() { injectImageButton(img); }, { once: true });
            }
        });
    }

    function scanVideos() {
        document.querySelectorAll('[class*="block-video"]').forEach(function(container) {
            injectVideoButton(container);
        });
    }

    function startObserver() {
        if (domObserverActive) return;
        domObserverActive = true;
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
    }

    function init() {
        console.log('[Core] 启动（图片+视频下载+API劫持）');
        setTimeout(function() { scanImages(); scanVideos(); }, 2000);
        startObserver();
        setInterval(function() { scanImages(); scanVideos(); }, 5000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
