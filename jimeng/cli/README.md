# jimeng-cli

[English README](./README.en.md)

一个以 API 为主的即梦 CLI，用于图片/视频生成、积分查询、模型查看和结果下载。

- npm: https://www.npmjs.com/package/@yang0/jimeng-cli
- GitHub: https://github.com/yang0/jimeng-cli

## 功能

- 从 Netscape 格式的 cookie 文件加载登录态。
- 直接调用即梦 HTTP API 提交图片和视频生成任务。
- 在下载结果时自动等待任务完成。
- 查询当前积分余额。
- 查看当前 CLI 支持的图片/视频模型别名。

## 安装

### 通过 npm 安装

```bash
npm install -g @yang0/jimeng-cli
jimeng --help
```

### 本地开发

```bash
npm install
```

## 快速开始

```bash
# 验证 cookie 是否可用
jimeng auth check --cookie-file "G:\cookies\jimeng.txt"

# 查看积分余额
jimeng credit --cookie-file "G:\cookies\jimeng.txt"

# 查看当前支持的模型
jimeng models

# 只提交图片任务，不等待
jimeng image generate "一只霓虹狐狸，赛博朋克风格" --cookie-file "G:\cookies\jimeng.txt"

# 提交图片任务并下载结果
jimeng image generate "一只霓虹狐狸，赛博朋克风格" --download --cookie-file "G:\cookies\jimeng.txt"

# 提交视频任务并下载结果
jimeng video generate "赛博朋克城市上空掠过一艘发光飞船" --download --cookie-file "G:\cookies\jimeng.txt"

# 查看历史任务
jimeng history list --limit 10 --cookie-file "G:\cookies\jimeng.txt"
```

## 使用说明

- `--download` 的含义是：提交任务、等待完成，然后自动下载结果。
- cookie 需要是 Netscape 格式文件，例如 `G:\cookies\jimeng.txt`。
- cookie 可以通过 Chrome 插件 **Get cookies.txt LOCALLY** 导出为 Netscape 格式。
- 默认图片生成走的是逆向得到的即梦网页接口链路，不是官方公开 API。
- 按当前真实联调结果，默认图片路径与网页侧 `5.0 Lite` 行为一致，且没有观察到积分减少。
- `models` 输出的是 CLI 维护的 API 别名；即梦网页返回的实际模型展示名仍可能显示为 `5.0 Lite`。
- 浏览器工具只用于调试网页请求变化，正式 CLI 运行路径仍然是纯代码。

## 常见使用场景

```bash
# 检查账号登录态
jimeng auth check --cookie-file "G:\cookies\jimeng.txt"

# 生成并下载默认免费风格图片
jimeng image generate "一只霓虹狐狸，赛博朋克风格" --download --cookie-file "G:\cookies\jimeng.txt"

# 生成并下载视频
jimeng video generate "赛博朋克城市上空掠过一艘发光飞船" --download --cookie-file "G:\cookies\jimeng.txt"

# 查看历史任务
jimeng history list --limit 10 --cookie-file "G:\cookies\jimeng.txt"
```

## 命令说明

- `auth check`：验证 cookie 文件对应的即梦登录态。
- `credit`：输出赠送积分、购买积分、VIP 积分和总积分。
- `models`：列出当前 CLI 支持的图片/视频模型别名。
- `image generate`：提交图片生成任务。
- `video generate`：提交视频生成任务。
- `task get` / `task wait`：查看已有任务状态或等待任务完成。
- `history list`：读取已有生成历史。
- `download`：解析并下载已有任务的输出结果。

## 打包说明

- npm 可执行入口指向 `dist/cli.js`。
- 执行 `npm pack` / `npm publish` 时会先触发 `prepack` 自动构建。
- 最终 tarball 只包含构建产物和 README 文档，不会带上源码测试目录。

## 浏览器调试兜底

主实现路径仍然是 API-first。只有当即梦网页请求结构发生变化、需要补抓包时，才使用下面这个 Chrome profile：

```text
G:\chrome_data\remote_debug
```

这个 profile 只用于 DevTools 核对和 payload 恢复，不作为 CLI 的主执行方式。
