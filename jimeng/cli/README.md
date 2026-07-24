# jimeng-cli

[English README](./README.en.md)

API-first CLI for Jimeng image/video generation, task polling, history, credits, model listing, and downloads.

```powershell
cd jimeng\cli
npm install
npm run build
node dist\cli.js --help
node dist\cli.js auth check --cookie-file .\cookies\jimeng.txt
node dist\cli.js image generate "一只霓虹狐狸" --download --cookie-file .\cookies\jimeng.txt
node dist\cli.js video generate "赛博朋克城市上空飞过发光飞船" --download --cookie-file .\cookies\jimeng.txt
```

Cookie files must use Netscape format and must remain outside version control. Set `JIMENG_COOKIE_FILE` instead of repeating `--cookie-file` if preferred.
