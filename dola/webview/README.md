# Dola WebView2 壳

用 **Edge WebView2**（`pywebview` + `edgechromium`）登录 dola，避免完整 Chrome 一堆系统弹窗/扩展干扰。思路对齐参考软件：

- 内嵌浏览器，不是整站 Chrome 壳
- **一号一个 `storage_path` profile**（会话隔离）
- 登录成功后 **导出 Netscape Cookie** → `G:\cookies\dola`，给 `media-cli` 号池用

## 注入壳（对齐 reseller 生视频/下载）

手动测试视频生成时，可直接双击：

```bat
manual_video_test.cmd
```

默认使用 `GlynisWilliams9z0h`。也可指定其他已登录账号：

```bat
manual_video_test.cmd CorettaCagle4vmrx
manual_video_test.cmd list
```

手动下载的视频保存在 `..\cli\downloads\inject`。

原软件逻辑：**WebView 打开已登录站 + 注入脚本**，生成由你在网页里操作；注入只负责 15s 与无水印下载。

```bat
cd e:\projectHome\media-cli\dola\webview
REM 列出有 session 的 profile
.\.venv\Scripts\python.exe inject_shell.py --list

REM 打开注入壳（自动挑有 session 的号，或指定账号）
inject_shell.cmd GlynisWilliams9z0h
```

注入内容（`inject/`）：

| 脚本 | 作用 |
|------|------|
| `bridge.js` | 把 `chrome.webview.postMessage` 接到 pywebview 下载 |
| `dola_fifteen_seconds.js` | 时长菜单加 15s + patch `completion` → seedance_v2.0 / duration=15 |
| `dola_core.js` | 解析 vid / get_play_info，页面按钮「⬇ 下载视频/图片」 |
| `dola_capture.js` | 资源捕获 |

使用步骤（手动，对齐原软件）：

1. 先保证 profile 已登录（`login_one.cmd` 导出 cookie 的那个号）
2. 开注入壳 → 进 `/chat`
3. 自己点 **视频生成** → 传参考图（可 0 张）→ 时长选 **15s** → 发提示词
4. 出片后点 **⬇ 下载视频**，文件进 `cli\downloads\inject`

自动生成 + 下载（WebView，不走 CDP）：

```bat
inject_shell.cmd auto GlynisWilliams9z0h 15 E:\temp\avarta.png
```

或：

```bat
.\.venv\Scripts\python.exe inject_shell.py --account GlynisWilliams9z0h --auto --duration 15 --aspect-ratio 9:16 --file E:\temp\avarta.png --prompt "..." --out ..\cli\downloads\inject --close
```

流程：注入脚本 → 点视频生成 → 传 0–n 图 → 填词 → 发送 → 轮询无水印 URL → 下载。

菜单：**Dola注入 → 重新注入脚本 / 打开下载目录**

## 安装

```bat
cd e:\projectHome\media-cli\dola\webview
start.cmd
```

或：

```bat
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

需要本机已装 **WebView2 Runtime**（你机器上已有 Edge WebView）。

## 顺序：先登录，再导出

导出 Cookie **要求已登录**。未登录时菜单/脚本会拒绝导出。

### 方式 A：一条命令登录 + 成功后导出

```bat
REM 使用 google_mail.txt 第 0 个账号
login_one.cmd 0
```

等价：

```bat
.venv\Scripts\python.exe dola_webview.py ^
  --accounts ..\google_mail.txt --index 0 ^
  --auto-login --auto-export ^
  --out G:\cookies\dola
```

流程：

1. 打开 WebView2（一号一 profile）
2. 自动：Log In → Google 登录 → 填邮箱密码 → 点 Next / 同意
3. OAuth 回到 dola 后自动点年龄确认「确认」，**留在 callback 等 SPA 换 session**（勿提前跳走）
4. **确认 dola 会话有效后** 才导出到 `G:\cookies\dola\dola_<id>.txt`
5. Cookie 优先 `window.get_cookies()`（SimpleCookie）；失败则解密 WebView2 profile SQLite
6. 若 Google 弹验证码/风控：窗口保留，人工处理完再菜单导出

仅导出（profile 已登录）：

```bat
.venv\Scripts\python.exe dola_webview.py --account GlynisWilliams9z0h --export-only --out G:\cookies\dola --close-after-export
```

### 方式 B：半自动（更稳）

```bat
start.cmd
```

或：

```bat
start_account.cmd dola_acc4
```

1. 新建/选择账号并打开 WebView  
2. 手动完成 Google 登录  
3. 菜单 **Dola → 导出 Cookie（需已登录）**

### 菜单

| 菜单 | 作用 |
|------|------|
| 打开 Dola 首页 | 回到 dola.com |
| 尝试点 Log In / Google | 只点按钮，不填密码 |
| 自动 Google 登录 | 有 email/password 时跑登录流 |
| 导出 Cookie（需已登录） | 未登录会跳过 |
| 清理本账号会话 Cookie | 仅清当前 profile |

## 批量导出当前目录账号

在 `webview` 目录执行：

```bat
export_all.cmd
```

脚本会读取项目根目录的 `google_mail.txt`，顺序启动 WebView2 登录，并将 Cookie
保存到 `G:\cookies\dola`。已有同名且非空的 `dola_<账号>.txt` 会自动跳过。

- `export_all.cmd --dry-run`：仅预览会处理哪些账号。
- `export_all.cmd --force`：忽略已有 Cookie，强制重导出。

## 和 CLI 对接

```bat
cd e:\projectHome\media-cli\dola\cli
node src\cli.js --account-pool G:\cookies\dola --list-accounts
node src\cli.js --account-pool G:\cookies\dola --video-gen --duration 15 --prompt "..." --out .\downloads
```

## 目录

```text
webview/
  dola_webview.py   # WebView2 主程序
  launcher.py       # 账号列表 GUI
  cookie_util.py    # Cookie 规范化 / Netscape
  profiles/         # 每账号 WebView 数据（自动生成）
  accounts.json     # 导出记录
  start.cmd
  start_account.cmd
```

## 为什么比 Chrome CDP 适合登录

| | Chrome CDP | WebView2 壳 |
|--|------------|-------------|
| UI | 完整浏览器，扩展/气泡多 | 嵌入窗口，干扰少 |
| 会话 | 共用 user-data 容易脏 | `storage_path` 一号一目录 |
| 参考软件 | 不像 | 同为 WebView2 路线 |
| 导出 | 需自己爬 Network | `window.get_cookies()` |

**建议仍不要脚本批量硬登 Google**；WebView 里人工过登录，导出 cookie 后用号池干活。
