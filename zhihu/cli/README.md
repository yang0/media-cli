# zhihu-plus-cli

独立的知乎回答与专栏文章证据截图 CLI，要求 Python 3.11+。它只截取明确指定的知乎回答/文章主体，不搜索、不发布、不下载原始媒体，也不会在无法定位主体时退化为整页截图。

## 安装

```powershell
cd zhihu\cli
python -m pip install -e .
```

## 认证

认证优先级为 `--cookie-file` > `ZHIHU_COOKIE` > 已登录 Chrome CDP。Cookie 文件支持原始 Cookie Header、Netscape 格式和 JSON 导出；认证检查只显示来源和 Cookie 数量，不显示名称或值。

```powershell
zhihu-plus auth check --cdp-port 9221
zhihu-plus auth check --cookie-file .\zhihu.cookies
$env:ZHIHU_COOKIE = "z_c0=...; d_c0=..."
```

默认 CDP 端口为 `9221`，可用 `--cdp-port` 覆盖。CDP 不可用但有 Cookie 时，工具会启动带临时 profile 的 CLI 独占 Chrome，完成后关闭进程并删除 profile；不会关闭用户已经打开的 Chrome。

## 截图

回答必须使用包含精确回答 ID 的详情 URL；文章使用专栏文章 URL。批量文件每行一个 URL，空行和 `#` 注释会忽略。

```powershell
zhihu-plus capture "https://www.zhihu.com/question/<question-id>/answer/<answer-id>"
zhihu-plus capture "https://zhuanlan.zhihu.com/p/<article-id>"
zhihu-plus capture --input .\zhihu-urls.txt --wait 4
zhihu-plus capture "https://zhuanlan.zhihu.com/p/<article-id>" --chrome "C:\path\to\chrome.exe"
```

回答截图由实时 DOM 中的问题标题和目标回答克隆组成，明确排除同页其他回答；文章截图只取 `Post-Main`/正文主体。定位失败、登录失效、验证码或删除页面会失败并拒绝整页截图。

长 DOM 会先按不超过 12,000 CSS 像素的带宽截取并拼接，再按语义边界切成宽:高不超过 9:16 的 PNG。找不到安全边界时最多硬切并保留默认 64 像素重叠，最后一张保持实际高度。

输出目录：

```text
downloads/zhihu/captures/<时间>/
├── manifest.json
└── images/
    ├── zhihu-answer-<id>-01-of-03.png
    ├── zhihu-answer-<id>-02-of-03.png
    └── zhihu-article-<id>-01-of-03.png
```

清单会记录原始输入、规范化来源 URL、内容类型、问题/回答 ID、作者、`capture_mode`、主体裁剪区域、DOM 分带、分片坐标、尺寸、重叠像素和 SHA-256。退出码为 0（全部成功）、2（认证/参数/页面解析失败或全部失败）、3（批量部分成功）。

## 离线测试

```powershell
cd zhihu\cli
python -m unittest discover -s tests -v
python -m compileall -q zhihu_cli
git diff --check
```
