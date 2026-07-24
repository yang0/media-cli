# jimeng-cli

[English README](./README.en.md)

以 API 为主的即梦 CLI，支持图片/视频生成、任务轮询、历史、积分、模型列表和结果下载。

```powershell
cd jimeng\cli
npm install
npm run build
node dist\cli.js --help
node dist\cli.js auth check --cookie-file .\cookies\jimeng.txt
node dist\cli.js image generate "一只霓虹狐狸" --download --cookie-file .\cookies\jimeng.txt
node dist\cli.js video generate "赛博朋克城市上空飞过发光飞船" --download --cookie-file .\cookies\jimeng.txt
```

Cookie 必须是 Netscape 格式，并且不能提交到 Git。也可以设置 `JIMENG_COOKIE_FILE` 环境变量。
