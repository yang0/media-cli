# auto_jimeng

即梦生图机器人（Playwright 版本），支持：

1. 根据提示词（可选参考图）自动提交即梦生图任务
2. 自动轮询任务状态并下载成图
3. 每天自动学习历史成功提示词，产出学习日报

## 默认目录（已按你的环境写好）

- 数据目录: `H:\bot_data\jimeng`
- Chrome 数据目录: `H:\chrome_data\user1`
- Cookie 文件: `H:\cookies\jimeng.txt`

## 安装

```powershell
cd E:\projectHome\auto_jimeng
python -m pip install -r requirements.txt
python -m playwright install chromium
```

## 快速开始

### 1) 直接生图并等待下载

```powershell
python jimeng_bot.py generate --prompt "赛博朋克街道上的橘猫，电影感，超清细节"
```

带参考图：

```powershell
python jimeng_bot.py generate --prompt "参考图同款风格的人像海报" --reference "D:\test\ref.jpg"
```

### 2) 只提交，不等待

```powershell
python jimeng_bot.py submit --prompt "国风山水，晨雾，光影层次丰富"
```

### 3) 轮询并下载待完成任务

```powershell
python jimeng_bot.py poll --timeout 120
```

### 4) 生成每日提示词学习报告

```powershell
python jimeng_bot.py learn
```

学习报告输出目录：

- `H:\bot_data\jimeng\learning\daily_YYYY-MM-DD.md`

### 5) 守护运行（自动轮询 + 每日学习）

```powershell
python jimeng_bot.py run --loop-interval 60 --learn-time 09:00
```

## 输出目录结构

```text
H:\bot_data\jimeng
├─ downloads
│  └─ YYYY-MM-DD
│     └─ <submit_id>
│        ├─ 01.png / 01.webp ...
│        └─ metadata.json
├─ learning
│  └─ daily_YYYY-MM-DD.md
├─ pending_tasks.json
└─ history.jsonl
```

## 说明

- 脚本会自动把“创作类型”切换到`图片生成`再提交。
- 账号如果排队中，会先写入 `pending_tasks.json`，后续 `poll` 或 `run` 会自动补下载。
- 如果 `H:\chrome_data\user1` 被占用，脚本会自动退回普通浏览器上下文并使用 cookie 登录态。
