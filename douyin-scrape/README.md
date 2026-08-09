# douyin-scrape — 抖音账号素材抓取 CLI

对标账号（如比奇堡学院）的**视频/音频/字幕/元数据**批量抓取与转录工具链。

## 流程（按序执行）

```bash
# 1. 拿 cookie（登录态）
python get_douyin_cookies.py

# 2. 枚举账号全部视频 ID（按 sec_uid）
python collect_douyin_ids.py        # 基础版
python collect_douyin_ids3.py       # 增强版（多账号核对 sec_uid）

# 3. 枚举帖子详情 → douyin_posts.json
python enum_douyin_posts.py

# 4. 批量下载音频
python download_all_audio.py        # 输出到 audio/（先 mkdir）

# 5. 转录（faster-whisper large-v3 + 4090，约 17x 实时）
python transcribe.py                # 单条
python batch_transcribe.py          # 批量 → subtitles/

# 6. 字幕 txt → markdown
python txt2md.py                    # → subtitles/md/
```

## 依赖

- Python 3.13（D:\Python313）+ faster-whisper（`HF_ENDPOINT=hf-mirror` 拉模型）
- API 需 UA Chrome/150+ + Referer（抖音反爬）；cookie 过期跑 get_douyin_cookies.py 刷新
- 输出目录先 mkdir（audio/、subtitles/）

## 迁移说明

自 `G:\videos\比奇堡学院\`（8/5 实战）迁移。素材成品（audio/subtitles/videos）留在原目录作素材库。
