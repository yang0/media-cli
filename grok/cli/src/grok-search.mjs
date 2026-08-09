#!/usr/bin/env node
// grok 搜索 CLI：用 Grok（x.com/i/grok，CDP 9221）搜索并返回结果
// 用法:
//   node grok-search.mjs "查询词" [--json] [--timeout 秒]        # 普通搜索
//   node grok-search.mjs --video "主题" [--timeout 秒]           # 视频搜索
//   node grok-search.mjs --attach 短评.md [--video]              # 第一步：上传附件，停下等核查
//   node grok-search.mjs --submit "指令" [--video] [--timeout 秒] # 第二步：复用 tab 填指令并提交
import { grokSearch } from './lib/grok-client.mjs';
import fs from 'node:fs';

const args = process.argv.slice(2);
const videoMode = args.includes('--video');
const attachMode = args.includes('--attach');
const submitMode = args.includes('--submit');
const json = args.includes('--json');
const tIdx = args.indexOf('--timeout');
const timeoutMs = tIdx > -1 ? Number(args[tIdx + 1]) * 1000 : 120000;
const keepOpen = args.includes('--keep-open');
const arg = args.find((a) => !a.startsWith('--'));

if (!arg) {
  console.error(
    '用法:\n  grok-search "查询词" [--json]\n  grok-search --video "主题"\n  grok-search --attach 短评.md [--video]\n  grok-search --submit "指令" [--video]',
  );
  process.exit(1);
}

const videoInstruction = '请帮我搜索该新闻相关的空镜视频（空镜头 B-roll：无字幕、无解说、无主体的环境/氛围画面，适合做解说背景），优先空镜；如果找不到合适的空镜，再找现场视频。给出具体的 YouTube 视频标题和链接，至少 3 个。';

try {
  if (attachMode) {
    // 一键模式：上传附件 + 填提示词 + 自动提交（不停留）
    if (!fs.existsSync(arg)) throw new Error(`文件不存在: ${arg}`);
    const r = await grokSearch(videoMode ? videoInstruction : '请阅读附件内容，给我一个简要总结。', {
      attachFile: arg,
      timeoutMs,
      keepOpen,
    });
    if (json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log('=== Grok 回答 ===');
      console.log(r.answer);
      if (r.links.length) {
        console.log('\n=== 链接 ===');
        for (const l of r.links.slice(0, 10)) console.log(`- ${l.text || l.href.slice(0, 60)}\n  ${l.href}`);
      }
    }
  } else if (submitMode) {
    // 第二步：复用已有 grok tab（附件在输入框），填指令并提交
    const r = await grokSearch(videoMode ? videoInstruction : arg, { resume: true, timeoutMs, keepOpen });
    if (json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log('=== Grok 回答 ===');
      console.log(r.answer);
      if (r.links.length) {
        console.log('\n=== 链接 ===');
        for (const l of r.links.slice(0, 10)) console.log(`- ${l.text || l.href.slice(0, 60)}\n  ${l.href}`);
      }
    }
  } else {
    // 普通/视频搜索（文字查询）
    const query = videoMode
      ? `帮我找最合适的 YouTube 背景视频（主题：${arg}），给出具体的视频标题和链接，至少 3 个。`
      : arg;
    const r = await grokSearch(query, { timeoutMs, keepOpen });
    if (json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log('=== Grok 回答 ===');
      console.log(r.answer);
      if (r.links.length) {
        console.log('\n=== 链接 ===');
        for (const l of r.links.slice(0, 10)) console.log(`- ${l.text || l.href.slice(0, 60)}\n  ${l.href}`);
      }
    }
  }
} catch (e) {
  console.error('Grok 搜索失败:', e.message);
  process.exit(1);
}
