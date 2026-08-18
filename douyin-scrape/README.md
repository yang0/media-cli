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
- 账号搜索/截图需要 Python `websockets`（例如 `python -m pip install websockets`）
- API 需 UA Chrome/150+ + Referer（抖音反爬）；cookie 过期跑 get_douyin_cookies.py 刷新
- 输出目录先 mkdir（audio/、subtitles/）

## 账号搜索与主页截图（两个独立命令）

这两个入口共享的只有 Chrome CDP 连接、页面 URL 校验和基础解析代码，业务流程互不调用：

- `account_search.py` 只搜索、去重、评分和导出账号，**不会生成截图**。
- `account_capture.py` 只打开用户明确提供的 `/user/<sec_uid>` 主页并截图，**不会搜索、排名或读取搜索关键词**。

先用已登录的 Chrome 开启 CDP（默认端口 9221），然后运行对应命令：

```powershell
# 搜索热门账号：默认读取 30 个候选并输出前 10 个
python account_search.py "财经" --limit 30 --top 10 --sort hot

# 可选排序：hot / followers / likes / search
python account_search.py "财经" --sort likes --output-dir .\downloads\account-search\manual-run

# 截取一个明确指定的主页（参数可以是完整 URL 或 sec_uid）
python account_capture.py "https://www.douyin.com/user/MS4wLjABAAAA..."
python account_capture.py "MS4wLjABAAAA..." --cdp-port 9221

# 从文本逐行截取多个明确指定的主页；空行和 # 注释会忽略，重复 sec_uid 会去重
python account_capture.py --input .\account-urls.txt --output-dir .\downloads\account-screenshots\manual-run
```

搜索输出默认在 `downloads/account-search/<时间>-<关键词>/`：

```text
accounts.json   # 原始候选数、采集时间、账号字段、热度分项
accounts.csv    # 方便筛选
report.md       # 主页、粉丝、获赞、搜索排名、认证和热度分项摘要
```

截图输出默认在 `downloads/account-screenshots/<时间>/`：

```text
manifest.json   # 每个输入的 URL、sec_uid、时间、状态、截图模式和尺寸
images/         # 仅包含账号头部及前两排作品的 PNG（作品不足两排时按实际加载区域）
```

公开搜索卡片可直接获得的热门度是可解释的相对排序：粉丝规模 45%、累计获赞 35%、搜索可见性/认证 20%。原始分项会写入 JSON；搜索命令不会把未采集到的近期作品互动或更新活跃度当成实时数据。

边界与安全说明：

- 截图命令只接受 `douyin.com/user/<sec_uid>` 或裸 `sec_uid`，会拒绝搜索页、作品页、其他域名和带 query/fragment 的 URL。
- 截图只保存账号内容区，至少覆盖前两排作品，并排除侧栏、通知和当前登录头像；第二排懒加载时会做一次有限滚动后回到顶部测量。无法可靠定位内容区时直接失败，不退化为包含个人会话界面的整页截图。
- 页面出现验证码/安全验证时会明确失败，不自动绕过；请在 Chrome 中手动处理后重试。
- 两个命令都使用当前已登录 Chrome 会话，不把 Cookie 写入输出；不要把 Cookie 文件或浏览器 profile 提交到 Git。
- 每次默认创建新的时间戳目录，不覆盖上一批证据。`--cdp-port`、`--output-dir`、等待时间和视口均可覆盖，代码不依赖 `G:` 路径。
- 抖音前端字段或页面结构变化可能导致解析失败；截图清单会记录错误，搜索不会把不可核验的空结果伪装成热门账号。

纯解析、去重、评分、输入校验和输出边界测试不需要真实抖音登录：

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
```

## 迁移说明

自 `G:\videos\比奇堡学院\`（8/5 实战）迁移。素材成品（audio/subtitles/videos）留在原目录作素材库。
