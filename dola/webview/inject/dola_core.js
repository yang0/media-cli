(function () {
    'use strict';
    if (window.__dolaCoreLoaded) return;
    window.__dolaCoreLoaded = true;

    console.log('[DolaCore] Dola 无水印下载启动（同步浏览器插件逻辑）');

    // ==================== 状态 ====================
    var imageDb = new Map();         // key(rc_gen_image path) → { no_watermark_url, width, height }
    var imageUrlMap = new Map();     // URL片段 → { no_watermark_url, width, height }
    var videoDb = new Map();         // messageId → vid
    var videoUrlDb = new Map();      // vid → { mainUrl, width, height, score }
    var seenUrls = new Set();
    var processedVideos = new WeakSet();
    var processedImages = new WeakSet();
    var observerActive = false;

    function sendToHost(data) {
        if (window.chrome && window.chrome.webview) {
            window.chrome.webview.postMessage(data);
        }
    }

    // ==================== 原生函数备份 ====================
    var _parse = JSON.parse.bind(JSON);
    var _fetch = window.fetch.bind(window);
    var _xhrOpen = XMLHttpRequest.prototype.open;
    var _xhrSend = XMLHttpRequest.prototype.send;

    // ==================== 工具 ====================
    function extractFileKey(url) {
        if (!url) return null;
        var m = url.match(/rc_gen_image\/([^?~]+)/);
        return m ? m[1] : null;
    }

    function extractHash(url) {
        if (!url) return null;
        var m = url.match(/([0-9a-f]{32})/i);
        return m ? m[1].toLowerCase() : null;
    }

    function extractAllKeys(url) {
        if (!url) return [];
        var keys = [];
        var rcKey = extractFileKey(url);
        if (rcKey) keys.push(rcKey);
        try {
            var u = new URL(url);
            var pathParts = u.pathname.split('/').filter(Boolean);
            if (pathParts.length > 0) {
                var last = pathParts[pathParts.length - 1];
                last = last.split('~')[0];
                if (last.length > 8) keys.push(last);
                var noExt = last.replace(/\.[a-z]{3,4}$/i, '');
                if (noExt.length > 8 && noExt !== last) keys.push(noExt);
            }
        } catch (_) {}
        var hash = extractHash(url);
        if (hash) keys.push(hash);
        var unique = [];
        for (var i = 0; i < keys.length; i++) {
            if (unique.indexOf(keys[i]) === -1) unique.push(keys[i]);
        }
        return unique;
    }

    function walkJSON(obj, visit, depth) {
        depth = depth || 0;
        if (depth > 20 || obj == null || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
            for (var i = 0; i < obj.length; i++) walkJSON(obj[i], visit, depth + 1);
        } else {
            visit(obj);
            var vals = Object.values(obj);
            for (var vi = 0; vi < vals.length; vi++) walkJSON(vals[vi], visit, depth + 1);
        }
    }

    function findVid(obj, depth) {
        depth = depth || 0;
        if (depth > 10 || !obj) return null;
        if (Array.isArray(obj)) {
            for (var i = 0; i < obj.length; i++) { var r = findVid(obj[i], depth + 1); if (r) return r; }
            return null;
        }
        if (typeof obj !== 'object') return null;
        var vid = obj.vid || obj.video_id || obj.video_key || obj.video_vid;
        if (typeof vid === 'string' && vid.length > 5) {
            if (vid.indexOf('v0') === 0 || /^[a-zA-Z0-9]{10,}$/.test(vid)) return vid;
        }
        var vals = Object.values(obj);
        for (var vi = 0; vi < vals.length; vi++) { var r = findVid(vals[vi], depth + 1); if (r) return r; }
        return null;
    }

    function isLikelyNoWatermarkUrl(url, key) {
        if (!url) return false;
        var text = ((key || '') + ' ' + decodeURIComponent(url)).toLowerCase();
        return /no[_-]?watermark|without[_-]?watermark|video_gen_no_watermark|original|origin|raw|watermark=0/.test(text);
    }

    function isLikelyWatermarkedUrl(url, key) {
        if (!url) return false;
        var text = ((key || '') + ' ' + decodeURIComponent(url)).toLowerCase();
        if (isLikelyNoWatermarkUrl(url, key)) return false;
        return /watermark=1|water_mark|watermark|logo=|watermark_logo|wm_|lr=cici_ai/i.test(text);
    }

    function scoreVideoUrlCandidate(candidate) {
        if (!candidate || !candidate.url || typeof candidate.url !== 'string') return -Infinity;
        // 先尝试解码 base64 编码的 URL
        if (candidate.url.indexOf('http') !== 0 && candidate.url.indexOf('://') === -1) {
            candidate.url = decodeVideoUrl(candidate.url);
        }
        if (candidate.url.indexOf('http') !== 0) return -Infinity;
        var key = String(candidate.key || '');
        var source = String(candidate.source || '');
        var text = (key + ' ' + source + ' ' + decodeURIComponent(candidate.url)).toLowerCase();
        var score = 0;
        if (source.indexOf('original_media_info') !== -1) score += 120;
        if (/\b(no[_-]?watermark|no_watermark_url)\b/.test(text)) score += 110;
        if (/\b(original|origin|raw)\b/.test(text)) score += 90;
        if (text.indexOf('video_gen_no_watermark') !== -1) score += 80;
        if (/\bmain(_url)?\b/.test(text)) score += 20;
        if (candidate.url.indexOf('.mp4') !== -1) score += 12;
        if (candidate.width && candidate.height) score += Math.min(20, Math.round((candidate.width * candidate.height) / 300000));
        if (isLikelyWatermarkedUrl(candidate.url, key + ' ' + source)) score -= 160;
        return score;
    }

    function chooseBestVideoUrl(candidates) {
        var best = null, bestScore = -Infinity;
        for (var i = 0; i < candidates.length; i++) {
            var score = scoreVideoUrlCandidate(candidates[i]);
            if (score > bestScore) { best = candidates[i]; bestScore = score; }
        }
        return best ? { url: best.url, width: best.width, height: best.height, score: bestScore } : null;
    }

    function rememberVideoUrl(vid, candidates) {
        if (!vid || !candidates || !candidates.length) return;
        // 合并到 candidates 数组中，让 chooseBestVideoUrl 打分
        var filtered = [];
        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            if (c && typeof c.url === 'string' && c.url.indexOf('http') === 0) filtered.push(c);
        }
        var best = chooseBestVideoUrl(filtered);
        if (!best) return;
        var current = videoUrlDb.get(vid);
        if (current && current.score >= best.score) return;
        videoUrlDb.set(vid, best);
    }

    function makeNoWatermarkUrl(videoUrl) {
        if (!videoUrl) return videoUrl;
        var url = videoUrl;
        if (url.indexOf('lr=') !== -1) url = url.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark');
        if (url.indexOf('watermark') !== -1) {
            url = url.replace(/watermark=1/g, 'watermark=0');
            url = url.replace(/~tplv-[^.?&]*watermark[^.?&]*/gi, '');
        }
        if (url.indexOf('logo=') !== -1) url = url.replace(/[&?]logo=[^&]*/g, '');
        return url;
    }

    // ==================== 通知 C# 更新右侧面板 ====================
    var _notifyTimer = 0;
    function notifyNewData() {
        if (_notifyTimer) {
            clearTimeout(_notifyTimer);
            _notifyTimer = 0;
        }
        _notifyTimer = setTimeout(function() {
            _notifyTimer = 0;
            // 发送视频URL更新（vid → 解码后的真实URL）
            var urlUpdates = [];
            var urlEntries = Array.from(videoUrlDb.entries());
            for (var ui = 0; ui < urlEntries.length; ui++) {
                var entry = urlEntries[ui];
                var vid = entry[0];
                var info = entry[1];
                if (vid && info && info.url && info.url.indexOf('http') === 0) {
                    urlUpdates.push({ vid: vid, url: info.url, width: info.width, height: info.height });
                }
            }
            if (urlUpdates.length) {
                sendToHost({ type: 'videoUrlUpdate', data: urlUpdates });
            }
            // 发送图片数据
            if (imageDb.size) {
                var imgData = [];
                var imgIter = Array.from(imageDb.entries());
                for (var ii = 0; ii < imgIter.length; ii++) {
                    var item = imgIter[ii][1];
                    imgData.push({
                        no_watermark_url: item.no_watermark_url,
                        width: item.width,
                        height: item.height,
                        coverUrl: item.no_watermark_url
                    });
                }
                if (imgData.length) {
                    sendToHost({ type: 'imageDataExtracted', data: imgData });
                }
            }
        }, 300);
    }

    // ==================== 图片数据提取 ====================
    function storeImageData(url, data) {
        var keys = extractAllKeys(url);
        var rcKey = extractFileKey(url);
        if (rcKey && !imageDb.has(rcKey)) imageDb.set(rcKey, data);
        for (var i = 0; i < keys.length; i++) {
            if (!imageUrlMap.has(keys[i])) imageUrlMap.set(keys[i], data);
        }
    }

    function extractImages(creations) {
        if (!Array.isArray(creations)) return;
        for (var i = 0; i < creations.length; i++) {
            var cr = creations[i];
            var raw = cr && cr.image && cr.image.image_ori_raw;
            if (raw && raw.url) {
                var imgData = { no_watermark_url: raw.url, width: raw.width, height: raw.height };
                storeImageData(raw.url, imgData);
            }
        }
    }

    function captureVideoUrls(vid, node) {
        if (!vid || !node || typeof node !== 'object') return;
        var candidates = [
            { key: 'main_url', source: 'original_media_info', url: node.original_media_info && node.original_media_info.main_url, width: node.original_media_info && node.original_media_info.width, height: node.original_media_info && node.original_media_info.height },
            { key: 'no_watermark_url', source: 'node', url: node.no_watermark_url, width: node.width || node.video_width, height: node.height || node.video_height },
            { key: 'original_url', source: 'node', url: node.original_url, width: node.width || node.video_width, height: node.height || node.video_height },
            { key: 'main_url', source: 'node', url: node.main_url, width: node.width || node.video_width, height: node.height || node.video_height },
            { key: 'play_url', source: 'node', url: node.play_url, width: node.width || node.video_width, height: node.height || node.video_height },
            { key: 'download_url', source: 'node', url: node.download_url, width: node.width || node.video_width, height: node.height || node.video_height },
            { key: 'video_url', source: 'node', url: node.video_url, width: node.width || node.video_width, height: node.height || node.video_height },
            { key: 'main', source: 'play_info', url: node.play_info && node.play_info.main, width: node.play_info && node.play_info.width, height: node.play_info && node.play_info.height }
        ];
        rememberVideoUrl(vid, candidates);
    }

    // ==================== 从 video_model 直接提取解码后的视频URL（匹配扩展逻辑） ====================
    function extractAndStoreVideoUrl(vid, videoModelStr) {
        if (!vid || !videoModelStr || typeof videoModelStr !== 'string') return;
        try {
            var model = JSON.parse(videoModelStr);
            var videoList = model.video_list || {};
            // 优先 1080p → 720p → others
            var encodedUrl = (videoList.video_2 || videoList.video_1 || {}).main_url ||
                             (videoList.video_2 || videoList.video_1 || {}).backup_url_1;
            if (!encodedUrl) {
                // try any key
                var keys = Object.keys(videoList);
                for (var k = 0; k < keys.length; k++) {
                    encodedUrl = videoList[keys[k]].main_url || videoList[keys[k]].backup_url_1;
                    if (encodedUrl) break;
                }
            }
            if (!encodedUrl) return;
            var decoded = atob(encodedUrl);
            if (!decoded || (decoded.indexOf('http') !== 0 && decoded.indexOf('://') === -1)) {
                // try double-decode
                decoded = atob(decoded);
                if (!decoded || (decoded.indexOf('http') !== 0 && decoded.indexOf('://') === -1)) return;
            }
            // store directly - skip scoring, this is the best URL
            var cleaned = makeNoWatermarkUrl(decoded);
            videoUrlDb.set(vid, { url: cleaned, width: 0, height: 0, score: 9999 });
            console.log('[DolaCore] 视频URL已提取: ' + vid + ' → ' + cleaned.substring(0, 60) + '...');
        } catch(_) {}
    }

    function harvest(obj) {
        try {
            walkJSON(obj, function(node) {
                var creations = node && node.content && node.content.creation_block && node.content.creation_block.creations;
                if (creations) {
                    extractImages(creations);
                    // 也检查 creations 里的 video_model
                    for (var c = 0; c < creations.length; c++) {
                        var cr = creations[c];
                        if (cr && cr.video && cr.video.video_model) {
                            var vid = cr.video.vid || '';
                            if (vid) {
                                extractAndStoreVideoUrl(vid, cr.video.video_model);
                            }
                        }
                    }
                }

                var msgs = node && node.downlink_body && node.downlink_body.pull_singe_chain_downlink_body && node.downlink_body.pull_singe_chain_downlink_body.messages;
                if (msgs && Array.isArray(msgs)) {
                    for (var m = 0; m < msgs.length; m++) {
                        var msg = msgs[m];
                        var mid = String(msg.message_id || '').trim();
                        if (mid && mid !== '0') {
                            var vid = findVid(msg);
                            if (vid && !videoDb.has(mid)) videoDb.set(mid, vid);
                            var blocks = msg.content_block;
                            if (Array.isArray(blocks)) {
                                for (var b = 0; b < blocks.length; b++) {
                                    var cb = blocks[b];
                                    var crs = cb && cb.content && cb.content.creation_block && cb.content.creation_block.creations;
                                    if (crs) {
                                        extractImages(crs);
                                        for (var c2 = 0; c2 < crs.length; c2++) {
                                            var cr = crs[c2];
                                            if (cr && cr.video && cr.video.video_model) {
                                                var cv = cr.video.vid || vid || '';
                                                if (cv) extractAndStoreVideoUrl(cv, cr.video.video_model);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Deep search
                if (node && typeof node === 'object' && !Array.isArray(node)) {
                    var mid = String(node.message_id || node.msg_id || node.messageId || '').trim();
                    if (mid && mid !== '0' && !videoDb.has(mid)) {
                        var vid = findVid(node);
                        if (vid) videoDb.set(mid, vid);
                    }
                    var vid2 = node.vid || node.video_id || node.video_key || node.video_vid;
                    if (typeof vid2 === 'string' && vid2.length > 5) {
                        captureVideoUrls(vid2, node);
                    }
                }
            });
        } catch(_) {}
    }

    // ==================== Hook JSON.parse ====================
    JSON.parse = function() {
        var r = _parse.apply(null, arguments);
        try { harvest(r); notifyNewData(); } catch(_) {}
        return r;
    };

    // ==================== Hook fetch ====================
    window.fetch = function(input, init) {
        return _fetch(input, init).then(function(resp) {
            if (!resp.ok) return resp;
            var ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
            if (ct.indexOf('text/event-stream') !== -1 || ct.indexOf('application/json') !== -1) {
                var clonedResp = resp.clone();
                var body = clonedResp.body;
                if (!body) return resp;
                var reader = body.getReader();
                var dec = new TextDecoder();
                var text = '';
                reader.read().then(function processResult(result) {
                    if (result.done) {
                        text += dec.decode();
                        try { harvest(JSON.parse(text)); notifyNewData(); } catch(_) {}
                        return;
                    }
                    text += dec.decode(result.value, { stream: true });
                    return reader.read().then(processResult);
                }).catch(function() {});
            }
            return resp;
        }).catch(function() { return _fetch(input, init); });
    };

    // ==================== Hook XHR ====================
    XMLHttpRequest.prototype.open = function(method, url) {
        this.__df_url = typeof url === 'string' ? url : String(url);
        return _xhrOpen.call(this, method, url);
    };
    XMLHttpRequest.prototype.send = function() {
        var self = this;
        this.addEventListener('load', function() {
            var u = self.__df_url;
            if (!u || u.indexOf('chain/single') === -1) return;
            try { harvest(JSON.parse(self.responseText)); notifyNewData(); } catch(_) {}
        });
        return _xhrSend.apply(this, arguments);
    };

    // ==================== Base64 视频地址解码 ====================
    function decodeVideoUrl(encoded) {
        if (!encoded || typeof encoded !== 'string') return null;
        if (encoded.indexOf('http') === 0 || encoded.indexOf('://') !== -1) return encoded;
        try {
            var decoded = atob(encoded);
            if (decoded.indexOf('http') === 0) return decoded;
            var decoded2 = atob(decoded);
            if (decoded2.indexOf('http') === 0) return decoded2;
        } catch(_) {}
        return encoded;
    }

    // ==================== 视频URL解析 ====================
    function resolveVideoUrl(vid) {
        if (!vid) return null;
        // 优先用 harvest 已提取并解码的 URL
        var cached = videoUrlDb.get(vid);
        if (cached && cached.url && (cached.url.indexOf('http') === 0 || cached.url.indexOf('://') !== -1)) {
            return { mainUrl: cached.url, width: cached.width, height: cached.height };
        }
        // 兜底：调用 get_play_info
        var aid = location.hostname.indexOf('dola.com') !== -1 ? '489823' : '497858';
        try {
            var xhr = new XMLHttpRequest();
            var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
            xhr.open('POST', location.origin + '/samantha/media/get_play_info?aid=' + aid + '&device_platform=web&samantha_web=1&use-olympus-account=1&version_code=20800&pkg_type=release_version&web_tab_id=' + uuid, false);
            xhr.setRequestHeader('accept', 'application/json');
            xhr.setRequestHeader('content-type', 'application/json');
            xhr.setRequestHeader('origin', location.origin);
            xhr.setRequestHeader('referer', location.href);
            xhr.send(JSON.stringify({ key: vid, type: 'video' }));
            if (xhr.status === 200) {
                var j = JSON.parse(xhr.responseText);
                if (j.code === 0 && j.data) {
                    var candidates = [];
                    var om = j.data.original_media_info;
                    if (om && om.main_url) candidates.push({ key: 'main_url', source: 'original_media_info', url: decodeVideoUrl(om.main_url), width: om.width || (om.meta && om.meta.width), height: om.height || (om.meta && om.meta.height) });
                    candidates.push({ key: 'no_watermark_url', source: 'data', url: decodeVideoUrl(j.data.no_watermark_url), width: j.data.width, height: j.data.height });
                    candidates.push({ key: 'original_url', source: 'data', url: decodeVideoUrl(j.data.original_url), width: j.data.width, height: j.data.height });
                    var playInfos = Array.isArray(j.data.play_infos) ? j.data.play_infos : [];
                    if (j.data.play_info) playInfos.push(j.data.play_info);
                    // video_list 结构（Dola 返回的）
                    var videoList = j.data.video_list || (j.data.video_info && j.data.video_info.data && j.data.video_info.data.video_list);
                    if (videoList && typeof videoList === 'object') {
                        var vKeys = Object.keys(videoList);
                        for (var kv = 0; kv < vKeys.length; kv++) {
                            var v = videoList[vKeys[kv]];
                            if (v && v.main_url) {
                                candidates.push({ key: 'main_' + vKeys[kv], source: 'video_list', url: decodeVideoUrl(v.main_url), width: v.vwidth || v.width, height: v.vheight || v.height });
                                if (v.backup_url_1) candidates.push({ key: 'bk1_' + vKeys[kv], source: 'video_list', url: decodeVideoUrl(v.backup_url_1), width: v.vwidth || v.width, height: v.vheight || v.height });
                            }
                        }
                    }
                    for (var pi = 0; pi < playInfos.length; pi++) {
                        var p = playInfos[pi];
                        if (!p || typeof p !== 'object') continue;
                        candidates.push({ key: 'main', source: 'play_info', url: decodeVideoUrl(p.main), width: p.width, height: p.height });
                        candidates.push({ key: 'main_url', source: 'play_info', url: decodeVideoUrl(p.main_url), width: p.width, height: p.height });
                    }
                    var best = chooseBestVideoUrl(candidates);
                    if (best && (best.url.indexOf('http') === 0 || best.url.indexOf('://') !== -1)) {
                        return { mainUrl: makeNoWatermarkUrl(best.url), width: best.width, height: best.height };
                    }
                }
            }
        } catch(_) {}
        if (videoUrlDb.has(vid)) {
            var cached = videoUrlDb.get(vid);
            return { mainUrl: makeNoWatermarkUrl(decodeVideoUrl(cached.url)), width: cached.width, height: cached.height };
        }
        return null;
    }

    // ==================== DOM 注入 ====================
    function injectStyles() {
        if (document.getElementById('__df_styles')) return;
        var s = document.createElement('style');
        s.id = '__df_styles';
        s.textContent = '.__df-btn{position:absolute!important;bottom:10px!important;right:10px!important;z-index:99999!important;display:inline-flex!important;align-items:center!important;gap:5px!important;padding:6px 12px!important;background:rgba(0,0,0,0.62)!important;color:#fff!important;border:none!important;border-radius:8px!important;font-size:12px!important;font-weight:500!important;cursor:pointer!important;backdrop-filter:blur(6px)!important;transition:background .2s!important;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',sans-serif!important;line-height:1!important;white-space:nowrap!important;pointer-events:all!important;user-select:none!important} .__df-btn:hover{background:rgba(0,0,0,0.82)!important} .__df-btn.__df-ok{background:rgba(16,185,129,0.85)!important} .__df-btn.__df-fail{background:rgba(239,68,68,0.82)!important}';
        (document.head || document.documentElement).appendChild(s);
    }

    function findContainer(imgEl) {
        var c = imgEl.parentElement;
        for (var i = 0; i < 8 && c && c !== document.body; i++) {
            var r = c.getBoundingClientRect();
            if (r.width >= 80 && r.height >= 60) {
                var imgs = c.querySelectorAll('img');
                var aiImgs = Array.from(imgs).filter(function(img) { return img.src && img.src.indexOf('http') === 0 && img.naturalWidth > 50; });
                if (aiImgs.length <= 1) break;
                if (c === imgEl.parentElement) break;
                return imgEl.parentElement;
            }
            c = c.parentElement;
        }
        return c || imgEl.parentElement;
    }

    function ensureRelative(el) {
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    }

    function findImageData(imgSrc) {
        if (!imgSrc) return null;
        var rcKey = extractFileKey(imgSrc);
        if (rcKey) { var data = imageDb.get(rcKey); if (data) return data; }
        var keys = extractAllKeys(imgSrc);
        for (var k = 0; k < keys.length; k++) { var data = imageUrlMap.get(keys[k]); if (data) return data; }
        var srcHash = extractHash(imgSrc);
        if (srcHash) {
            var entries = Array.from(imageUrlMap.entries());
            for (var e = 0; e < entries.length; e++) {
                if (entries[e][0].indexOf(srcHash) !== -1 || srcHash.indexOf(entries[e][0]) !== -1) return entries[e][1];
            }
        }
        try {
            var srcPath = new URL(imgSrc).pathname;
            var srcFile = srcPath.split('/').pop().split('~')[0].split('?')[0];
            var entries = Array.from(imageUrlMap.entries());
            for (var e = 0; e < entries.length; e++) {
                if (srcPath.indexOf(entries[e][0]) !== -1 || entries[e][0].indexOf(srcFile) !== -1) return entries[e][1];
            }
        } catch(_) {}
        return null;
    }

    // 暴露给 dola_capture.js 用于精准过滤
    window.__dolaFindImageData = findImageData;
    // vid → 解码后的真实视频URL
    window.__dolaGetVideoUrl = function(vid) {
        if (!vid) return null;
        var cached = videoUrlDb.get(vid);
        if (cached && cached.url) return cached.url;
        return null;
    };
    // vid → { url, width, height }
    window.__dolaGetVideoInfo = function(vid) {
        if (!vid) return null;
        var cached = videoUrlDb.get(vid);
        if (cached && cached.url) return { url: cached.url, width: cached.width, height: cached.height };
        return null;
    };
    // messageId → vid (从API消息中提取的映射，匹配下载按钮逻辑)
    window.__dolaGetVidByMessageId = function(mid) {
        if (!mid) return null;
        return videoDb.get(mid) || null;
    };
    // 完全按下载按钮逻辑解析视频URL（缓存 → get_play_info XHR → decode → 无水印 → 评分）
    window.__dolaResolveVideoUrl = resolveVideoUrl;

    function tryInjectImage(imgEl) {
        if (processedImages.has(imgEl)) return;
        var data = findImageData(imgEl.src);
        if (!data) return;
        processedImages.add(imgEl);
        var container = findContainer(imgEl);
        ensureRelative(container);
        if (container.querySelector('.__df-btn')) return;
        var btn = document.createElement('button');
        btn.className = '__df-btn';
        btn.innerHTML = '⬇ 下载图片';
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            e.preventDefault();
            if (btn.disabled) return;
            btn.disabled = true;
            btn.textContent = '下载中…';
            sendToHost({ type: 'download', url: data.no_watermark_url, filename: 'dola_img_' + (data.width || '') + 'x' + (data.height || '') + '_' + Date.now() + '.png' });
            setTimeout(function() {
                btn.disabled = false;
                btn.innerHTML = '✓ 已下载';
                btn.classList.add('__df-ok');
                setTimeout(function() { btn.innerHTML = '⬇ 下载图片'; btn.classList.remove('__df-ok'); }, 2000);
            }, 500);
        });
        container.appendChild(btn);
    }

    function tryInjectVideo(el) {
        if (processedVideos.has(el)) return;
        processedVideos.add(el);
        var cur = el;
        var mid = null;
        for (var i = 0; i < 20 && cur && cur !== document.body; i++) {
            if (cur.dataset && (cur.dataset.messageId || cur.dataset.message_id)) {
                mid = cur.dataset.messageId || cur.dataset.message_id;
                break;
            }
            cur = cur.parentElement;
        }
        ensureRelative(el);
        if (el.querySelector('.__df-btn')) return;
        var btn = document.createElement('button');
        btn.className = '__df-btn';
        btn.innerHTML = '⬇ 下载视频';
        var downloading = false;
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (downloading) return;
            downloading = true;
            btn.disabled = true;
            btn.textContent = '获取链接…';
            var vid = mid ? videoDb.get(mid) : null;
            // 兜底：从 DOM 中的 video 元素提取 vid
            if (!vid) {
                var videoEl = el.querySelector('video');
                if (videoEl && videoEl.src) {
                    var vm2 = videoEl.src.match(/\/v0[a-zA-Z0-9_-]+/);
                    if (vm2) vid = vm2[0].slice(1);
                }
            }
            if (!vid) {
                btn.disabled = false;
                btn.innerHTML = '⬇ 无vid';
                downloading = false;
                return;
            }
            var result = resolveVideoUrl(vid);
            if (!result || !result.mainUrl) {
                btn.disabled = false;
                btn.innerHTML = '⬇ 下载视频';
                downloading = false;
                return;
            }
            sendToHost({ type: 'download', url: result.mainUrl, filename: 'dola_video_' + (result.width || '') + 'x' + (result.height || '') + '_' + Date.now() + '.mp4' });
            downloading = false;
            btn.disabled = false;
            btn.innerHTML = '✓ 已发送下载';
            btn.classList.add('__df-ok');
            setTimeout(function() { btn.innerHTML = '⬇ 下载视频'; btn.classList.remove('__df-ok'); }, 2500);
        });
        el.appendChild(btn);
    }

    function scanDOM() {
        // 图片
        document.querySelectorAll('img[src*="rc_gen_image"]').forEach(tryInjectImage);
        document.querySelectorAll('[class*="creation"] img, [class*="Creation"] img').forEach(function(imgEl) {
            if (imgEl.src && imgEl.src.indexOf('http') === 0 && imgEl.naturalWidth > 50) tryInjectImage(imgEl);
        });
        if (imageUrlMap.size > 0) {
            document.querySelectorAll('img').forEach(function(imgEl) {
                if (!imgEl.src || imgEl.src.indexOf('http') !== 0) return;
                if (imgEl.src.indexOf('/static/') !== -1 || imgEl.src.indexOf('/icon') !== -1 || imgEl.src.indexOf('/logo') !== -1 || imgEl.src.indexOf('/avatar') !== -1 || imgEl.src.indexOf('/emoji') !== -1) return;
                if (imgEl.naturalWidth < 50) return;
                if (findImageData(imgEl.src)) tryInjectImage(imgEl);
            });
        }
        // 视频
        document.querySelectorAll('[class*="block-video"], [class*="video-block"], [class*="video_block"], [class*="VideoBlock"], [class*="video-container"], [class*="video-wrapper"]').forEach(tryInjectVideo);
        // 视频策略2：直接video元素
        document.querySelectorAll('video').forEach(function(videoEl) {
            var src = videoEl.currentSrc || videoEl.src;
            if (!src || src.indexOf('blob:') === 0) return;
            var container = videoEl.parentElement;
            for (var i = 0; i < 6 && container && container !== document.body; i++) {
                var r = container.getBoundingClientRect();
                if (r.width >= 100 && r.height >= 80) break;
                container = container.parentElement;
            }
            if (!container) return;
            ensureRelative(container);
            var existingBtn = container.querySelector('.__df-btn');
            tryInjectVideo(container);
        });
    }

    function startObserver() {
        injectStyles();
        setTimeout(scanDOM, 300);
        setTimeout(scanDOM, 1000);
        var obs = new MutationObserver(function() { setTimeout(scanDOM, 200); });
        if (document.body) obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'poster', 'data-message-id'] });
        setInterval(scanDOM, 3000);
    }

    // ==================== 启动 ====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserver);
    } else {
        startObserver();
    }
}