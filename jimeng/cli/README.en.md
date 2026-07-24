# jimeng-cli

[简体中文说明](./README.zh-CN.md)

API-first CLI for Jimeng image/video generation, task polling, history, credits, model listing, and downloads.

```powershell
cd jimeng\cli
npm install
npm run build
node dist\cli.js --help
node dist\cli.js auth check --cookie-file .\cookies\jimeng.txt
node dist\cli.js image generate "A neon fox in a cyberpunk city" --download --cookie-file .\cookies\jimeng.txt
node dist\cli.js video generate "A glowing ship over a futuristic skyline" --download --cookie-file .\cookies\jimeng.txt
```

Cookie files must use Netscape format and must never be committed. Set `JIMENG_COOKIE_FILE` to avoid passing the path on every command.
