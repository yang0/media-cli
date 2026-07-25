# Dola WebView2 壳

用 **Edge WebView2**（`pywebview` + `edgechromium`）登录 dola，避免完整 Chrome 一堆系统弹窗/扩展干扰。思路对齐参考软件：

- 内嵌浏览器，不是整站 Chrome 壳
- **一号一个 `storage_path` profile**（会话隔离）
- 登录成功后 **导出 Netscape Cookie** → `G:\cookies\dola`，给 `media-cli` 号池用

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
