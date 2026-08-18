# 微博 CLI

模块化的微博搜索与微博卡片截图工具，要求 Python 3.11+。搜索和截图是两个独立命令：搜索不会截图，截图只处理明确指定的微博 URL/ID。

本项目参考并复用了你授权的 [`dataabc/weibo-search`](https://github.com/dataabc/weibo-search) 的搜索 URL 映射、卡片字段和日期/小时细分思路，基准提交为 `b4535b71d36ae61d13ab0083a18a152914f14ba7`。本 CLI 不启用原项目的数据库或原始媒体下载 pipeline。

## 安装

```powershell
cd weibo\cli
python -m pip install -e .
```

如果只需要离线解析/分图测试，项目中的 `Pillow` 和 `lxml` 即可；完整搜索需要 `Scrapy`、`requests` 和已登录微博会话。

## 认证

认证优先级固定为：`--cookie-file` > `WEIBO_COOKIE` > 已登录 Chrome CDP（默认 9221）。Cookie 文件可使用原始 Cookie Header、Netscape 格式或 JSON 导出。

```powershell
weibo-cli auth check --cookie-file .\weibo.cookies
$env:WEIBO_COOKIE = "SUB=...; SUHB=..."
weibo-cli auth check
```

命令输出只显示认证来源和 Cookie 名称，不会打印 Cookie 值。遇到验证码、登录失效或频率限制会保留检查点并停止，不绕过验证。

## 搜索

一个命令对应一个组合查询；例如下面的两个词会作为同一个查询提交。默认最多输出 10 条，`--limit 0` 表示不限量。

```powershell
weibo-cli search "人工智能 机器人"
weibo-cli search "#人工智能#" --start 2026-08-01 --end 2026-08-18
weibo-cli search "财经" --type hot --contains video --region 北京 --limit 10
weibo-cli search "财经" --limit 0 --resume .\downloads\weibo\search\20260818-财经
```

`--start` 与 `--end` 必须成对出现。范围查询触发 46 页阈值时按日细分；仍饱和的日期按小时细分；小时仍饱和会写入 `truncated_windows`，命令返回码为 3，表示结果不保证完整。实际网络请求由 Scrapy 执行，默认下载间隔 10 秒并启用 0.5x–1.5x 有界随机化；可用 `--delay 0` 在本地 fixture 测试中关闭等待。

输出目录：

```text
downloads/weibo/search/<时间>-<查询词>/
├── results.jsonl
├── results.csv
├── manifest.json
├── checkpoint.json
└── state.sqlite3
```

`state.sqlite3` 仅用于运行状态、窗口检查点和微博 ID 去重，不是业务数据库输出。JSONL 保留数组字段；CSV 使用分号连接数组字段。使用 `--resume` 时会恢复已保存的 seen ID 数量，并优先恢复未完成的日/小时细分窗口，不会把已细分任务丢回初始范围。

## 微博截图

截图命令只接受明确的微博详情 URL、数字微博 ID 或 URL 文本文件：

```powershell
weibo-cli capture "https://weibo.com/123456/AbCdEf"
weibo-cli capture 1234567890123456
weibo-cli capture --input .\weibo-urls.txt
```

工具优先复用已登录 Chrome CDP，打开微博详情页后展开“全文”，等待头像、正文、嵌套转发和卡片媒体加载完成，再裁剪真实微博卡片并排除导航、评论区、侧栏和当前登录用户界面。无法唯一定位详情卡片时会报错，拒绝整页/首屏截图。视频只保留网页中的封面，不下载视频原文件。

如果现有 CDP 不可用且提供了 Cookie 文件或 `WEIBO_COOKIE`，工具会自动发现 Windows Chrome/Edge，启动 CLI 独占的临时 profile 与临时 CDP 端口，注入 Cookie，完成后关闭该进程并删除该临时 profile；不会关闭用户已经打开的浏览器。纯数字微博 ID 会转换为 `https://m.weibo.cn/detail/<id>`，传入的详情 URL 会原样保留为来源。

截图宽:高不超过 9:16。短微博只生成一张 PNG；长微博优先按正文、媒体和转发卡片边界分图，没有安全边界时按最大高度硬切并保留默认 64 像素重叠。每张图的坐标、尺寸、模式、重叠像素和 SHA-256 都记录在清单中。

输出目录：

```text
downloads/weibo/captures/<时间>/
├── manifest.json
└── images/
    ├── weibo-<id>-01-of-03.png
    ├── weibo-<id>-02-of-03.png
    └── weibo-<id>-03-of-03.png
```

## 测试

```powershell
cd weibo\cli
python -m unittest discover -s tests -v
python -m compileall -q weibo_cli
git diff --check
```

测试使用本地 HTML 与 Pillow fixture，不依赖真实登录微博。
