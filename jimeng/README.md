# Jimeng CLI

API-first CLI for Jimeng image and video generation, task polling, history, credits, and downloads.

```powershell
cd jimeng\cli
npm install
npm run build
node dist\cli.js models
node dist\cli.js image generate "一只霓虹狐狸" --download --cookie-file .\cookies\jimeng.txt
node dist\cli.js video generate "赛博朋克城市上空飞过发光飞船" --download --cookie-file .\cookies\jimeng.txt
```

The cookie file must use Netscape format. Keep it outside Git. See [`cli/README.en.md`](./cli/README.en.md) or [`cli/README.zh-CN.md`](./cli/README.zh-CN.md) for the full command reference.
