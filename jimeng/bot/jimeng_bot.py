#!/usr/bin/env python
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable

from playwright.async_api import Browser, BrowserContext, Page, Playwright, async_playwright


LOGGER = logging.getLogger("jimeng-bot")


DEFAULT_DATA_DIR = Path(r"H:\bot_data\jimeng")
DEFAULT_CHROME_DATA_DIR = Path(r"H:\chrome_data\user1")
DEFAULT_COOKIE_FILE = Path(r"H:\cookies\jimeng.txt")
DEFAULT_BASE_URL = "https://jimeng.jianying.com/ai-tool/generate"


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def parse_netscape_cookie_file(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(f"cookie file not found: {path}")
    cookies: list[dict[str, Any]] = []
    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 7:
            continue
        domain, _, cookie_path, secure, expires, name, value = parts
        item: dict[str, Any] = {
            "domain": domain,
            "path": cookie_path or "/",
            "name": name,
            "value": value,
            "secure": secure.upper() == "TRUE",
        }
        if expires and expires != "0":
            try:
                item["expires"] = int(expires)
            except ValueError:
                pass
        cookies.append(item)
    if not cookies:
        raise RuntimeError(f"no valid cookies parsed from {path}")
    return cookies


@dataclass(slots=True)
class BotConfig:
    data_dir: Path
    chrome_data_dir: Path
    cookie_file: Path
    base_url: str
    headless: bool
    poll_interval_sec: int
    wait_timeout_sec: int
    daily_learn_time: str

    @property
    def downloads_dir(self) -> Path:
        return ensure_dir(self.data_dir / "downloads")

    @property
    def learning_dir(self) -> Path:
        return ensure_dir(self.data_dir / "learning")

    @property
    def pending_file(self) -> Path:
        return self.data_dir / "pending_tasks.json"

    @property
    def history_file(self) -> Path:
        return self.data_dir / "history.jsonl"


class TaskStore:
    def __init__(self, config: BotConfig) -> None:
        self.config = config
        ensure_dir(config.data_dir)
        ensure_dir(config.downloads_dir)
        ensure_dir(config.learning_dir)

    def _load_json(self, path: Path, default: Any) -> Any:
        if not path.exists():
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            LOGGER.warning("invalid json at %s, fallback to default", path)
            return default

    def _save_json(self, path: Path, value: Any) -> None:
        temp = path.with_suffix(path.suffix + ".tmp")
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(path)

    def list_pending(self) -> list[dict[str, Any]]:
        return self._load_json(self.config.pending_file, [])

    def save_pending(self, tasks: list[dict[str, Any]]) -> None:
        self._save_json(self.config.pending_file, tasks)

    def upsert_pending(self, task: dict[str, Any]) -> None:
        tasks = self.list_pending()
        replaced = False
        for idx, row in enumerate(tasks):
            if row.get("submit_id") == task.get("submit_id"):
                tasks[idx] = task
                replaced = True
                break
        if not replaced:
            tasks.append(task)
        self.save_pending(tasks)

    def remove_pending(self, submit_id: str) -> None:
        tasks = [x for x in self.list_pending() if x.get("submit_id") != submit_id]
        self.save_pending(tasks)

    def append_history(self, record: dict[str, Any]) -> None:
        with self.config.history_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def iter_history(self) -> list[dict[str, Any]]:
        if not self.config.history_file.exists():
            return []
        output: list[dict[str, Any]] = []
        with self.config.history_file.open("r", encoding="utf-8") as handle:
            for line in handle:
                raw = line.strip()
                if not raw:
                    continue
                try:
                    output.append(json.loads(raw))
                except json.JSONDecodeError:
                    continue
        return output


class PromptLearner:
    STOP_WORDS = {
        "the",
        "and",
        "with",
        "for",
        "from",
        "this",
        "that",
        "have",
        "has",
        "are",
        "you",
        "your",
        "please",
        "一个",
        "一种",
        "进行",
        "使用",
        "风格",
        "生成",
        "图片",
        "画面",
        "高清",
        "细节",
    }

    def __init__(self, store: TaskStore) -> None:
        self.store = store

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        return re.findall(r"[A-Za-z]{3,}|[\u4e00-\u9fff]{2,}", text.lower())

    def _top_keywords(self, prompts: list[str], limit: int = 24) -> list[tuple[str, int]]:
        counts: dict[str, int] = {}
        for prompt in prompts:
            for token in self._tokenize(prompt):
                if token in self.STOP_WORDS:
                    continue
                counts[token] = counts.get(token, 0) + 1
        return sorted(counts.items(), key=lambda item: item[1], reverse=True)[:limit]

    def generate_daily_note(self) -> Path:
        history = self.store.iter_history()
        successful = [
            item
            for item in history
            if item.get("event") == "completed"
            and item.get("prompt")
            and item.get("downloaded_files")
        ]
        successful = successful[-120:]
        prompts = [str(item["prompt"]) for item in successful]
        keywords = self._top_keywords(prompts)

        top_examples = prompts[-8:]
        top_examples.reverse()
        top_examples = top_examples[:5]

        subject = keywords[0][0] if len(keywords) > 0 else "主体"
        scene = keywords[1][0] if len(keywords) > 1 else "场景"
        style = keywords[2][0] if len(keywords) > 2 else "风格"
        detail = keywords[3][0] if len(keywords) > 3 else "细节"

        templates = [
            f"{subject}，{scene}，{style}风格，电影级光影，{detail}，高质量细节",
            f"{subject}特写，{scene}背景，镜头语言明确，构图平衡，8k",
            f"{subject}，超现实氛围，{style}，体积光，精细纹理，真实质感",
            f"{subject} + {scene}，低饱和配色，景深明显，故事感强",
            f"{subject}，{scene}，高对比，焦点清晰，避免杂乱背景",
        ]

        content_lines: list[str] = []
        content_lines.append(f"# 即梦提示词学习日报 - {date.today().isoformat()}")
        content_lines.append("")
        content_lines.append("## 1) 今日样本")
        if top_examples:
            for example in top_examples:
                content_lines.append(f"- {example}")
        else:
            content_lines.append("- 暂无成功样本，先跑几次生图后再学习效果更好。")

        content_lines.append("")
        content_lines.append("## 2) 高频关键词")
        if keywords:
            content_lines.append(
                "- " + " | ".join([f"{word}({count})" for word, count in keywords[:18]])
            )
        else:
            content_lines.append("- 暂无关键词。")

        content_lines.append("")
        content_lines.append("## 3) 模板策略")
        content_lines.append("- 固定结构: 主体 + 场景 + 风格 + 光影 + 构图 + 细节")
        content_lines.append("- 控制变量: 每次只改变一个维度（风格或镜头或色彩）")
        content_lines.append("- 负向约束: 明确“不需要的元素”，减少脏图")

        content_lines.append("")
        content_lines.append("## 4) 今日可直接复用模板")
        for line in templates:
            content_lines.append(f"- {line}")
        content_lines.append("")

        output_path = self.store.config.learning_dir / f"daily_{date.today().isoformat()}.md"
        output_path.write_text("\n".join(content_lines), encoding="utf-8")
        return output_path


class JiMengImageBot:
    TYPE_SELECT = ".type-select-BRd1AA"
    SELECT_OPTION = ".lv-select-option"
    PROMPT_TEXTAREA = "textarea[class*='prompt-textarea']"
    SUBMIT_BUTTON = "button[class*='submit-button']"
    FILE_INPUT = "input[type='file']"
    MODAL_BUTTONS = ".lv-modal-wrapper button"

    def __init__(self, config: BotConfig, store: TaskStore) -> None:
        self.config = config
        self.store = store
        self.playwright: Playwright | None = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
        self.page: Page | None = None
        self._persistent_context = False

    async def __aenter__(self) -> "JiMengImageBot":
        await self.start()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.close()

    async def start(self) -> None:
        self.playwright = await async_playwright().start()
        assert self.playwright is not None

        # Try persistent Chrome profile first. Fallback to normal context if profile is locked.
        try:
            self.context = await self.playwright.chromium.launch_persistent_context(
                user_data_dir=str(self.config.chrome_data_dir),
                channel="chrome",
                headless=self.config.headless,
                viewport={"width": 1600, "height": 1200},
                args=["--disable-blink-features=AutomationControlled"],
            )
            self._persistent_context = True
            LOGGER.info("launched with persistent Chrome profile")
        except Exception:
            LOGGER.info(
                "persistent context failed (likely profile in use), fallback normal context"
            )
            self.browser = await self.playwright.chromium.launch(
                headless=self.config.headless,
                args=["--disable-blink-features=AutomationControlled"],
            )
            self.context = await self.browser.new_context(viewport={"width": 1600, "height": 1200})
            self._persistent_context = False

        assert self.context is not None
        cookies = parse_netscape_cookie_file(self.config.cookie_file)
        await self.context.add_cookies(cookies)
        self.page = self.context.pages[0] if self.context.pages else await self.context.new_page()
        await self._prepare_page(force=True)

    async def close(self) -> None:
        if self.context is not None:
            try:
                await self.context.close()
            except Exception:
                pass
        if self.browser is not None:
            try:
                await self.browser.close()
            except Exception:
                pass
        if self.playwright is not None:
            await self.playwright.stop()

    async def _prepare_page(self, force: bool = False) -> None:
        assert self.page is not None
        if force or not self.page.url.startswith("https://jimeng.jianying.com/"):
            await self.page.goto(self.config.base_url, wait_until="domcontentloaded", timeout=120000)
            await self.page.wait_for_timeout(8000)
        await self._dismiss_modal()
        await self._scroll_to_bottom()

    async def _dismiss_modal(self) -> None:
        assert self.page is not None
        buttons = self.page.locator(self.MODAL_BUTTONS)
        count = await buttons.count()
        if count == 0:
            return
        for idx in range(count - 1, -1, -1):
            button = buttons.nth(idx)
            try:
                if await button.is_visible():
                    await button.click(timeout=1500)
                    await self.page.wait_for_timeout(400)
                    break
            except Exception:
                continue

    async def _scroll_to_bottom(self) -> None:
        assert self.page is not None
        try:
            await self.page.locator("body").press("End")
            await self.page.wait_for_timeout(700)
        except Exception:
            pass

    async def _ensure_image_mode(self) -> None:
        assert self.page is not None
        type_select = self.page.locator(self.TYPE_SELECT).first
        if await type_select.count() == 0:
            raise RuntimeError("cannot find generation type selector")
        text = (await type_select.inner_text()).strip()
        if "图片生成" in text:
            return
        await type_select.click()
        await self.page.wait_for_timeout(500)

        options = self.page.locator(self.SELECT_OPTION)
        count = await options.count()
        if count == 0:
            raise RuntimeError("type selector opened but no options found")

        clicked = False
        for idx in range(count):
            raw_text = (await options.nth(idx).inner_text()).strip()
            if "图片生成" in raw_text:
                await options.nth(idx).click()
                clicked = True
                break
        if not clicked and count >= 2:
            await options.nth(1).click()
            clicked = True
        await self.page.wait_for_timeout(1000)

        final_text = (await type_select.inner_text()).strip()
        if "图片生成" not in final_text:
            raise RuntimeError(f"failed to switch to image mode, current mode: {final_text}")

    async def _find_submit_button(self) -> Any:
        assert self.page is not None
        buttons = self.page.locator(self.SUBMIT_BUTTON)
        count = await buttons.count()
        if count == 0:
            raise RuntimeError("submit button not found")
        for idx in range(count - 1, -1, -1):
            btn = buttons.nth(idx)
            try:
                if await btn.is_visible():
                    return btn
            except Exception:
                continue
        return buttons.last

    async def _wait_button_enabled(self, button: Any, timeout_sec: int = 12) -> None:
        end_at = time.time() + timeout_sec
        while time.time() < end_at:
            if not await button.is_disabled():
                return
            await asyncio.sleep(0.3)
        raise RuntimeError("submit button is still disabled after filling prompt")

    async def submit_image_task(self, prompt: str, reference_image: Path | None = None) -> dict[str, Any]:
        assert self.page is not None
        await self._prepare_page()
        await self._ensure_image_mode()

        textarea = self.page.locator(self.PROMPT_TEXTAREA).first
        if await textarea.count() == 0:
            raise RuntimeError("prompt input not found")
        await textarea.click()
        await self.page.keyboard.press("Control+A")
        await self.page.keyboard.press("Backspace")
        await self.page.keyboard.type(prompt)
        await self.page.wait_for_timeout(250)

        if reference_image is not None:
            if not reference_image.exists():
                raise FileNotFoundError(f"reference image not found: {reference_image}")
            file_input = self.page.locator(self.FILE_INPUT).first
            if await file_input.count() == 0:
                raise RuntimeError("file input not found in image mode")
            await file_input.set_input_files(str(reference_image))
            await self.page.wait_for_timeout(800)

        button = await self._find_submit_button()
        await self._wait_button_enabled(button)

        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()

        async def handle_generate_request(req: Any) -> None:
            if "aigc_draft/generate" not in req.url:
                return
            body = req.post_data or ""
            submit_id = None
            payload: dict[str, Any] = {}
            try:
                payload = json.loads(body)
                submit_id = payload.get("submit_id")
            except json.JSONDecodeError:
                match = re.search(r'"submit_id":"([^"]+)"', body)
                if match:
                    submit_id = match.group(1)
            root_model = str((payload.get("extend") or {}).get("root_model", "")).lower()
            escaped_image_flag = '\\"type\\":\\"image\\"' in body or '"type":"image"' in body
            escaped_video_flag = '\\"type\\":\\"video\\"' in body or '"type":"video"' in body
            if escaped_image_flag or any(key in root_model for key in ["high_aes", "seedream", "image"]):
                mode = "image"
            elif escaped_video_flag or any(key in root_model for key in ["seedance", "video", "imitator"]):
                mode = "video"
            else:
                mode = "unknown"
            if submit_id and not future.done():
                future.set_result(
                    {
                        "submit_id": submit_id,
                        "mode": mode,
                        "request_url": req.url,
                        "captured_at": now_iso(),
                        "payload_preview": body[:1200],
                    }
                )

        listener: Callable[[Any], None] = lambda req: asyncio.create_task(handle_generate_request(req))
        self.page.on("request", listener)
        try:
            await button.click(timeout=15000)
            task_info = await asyncio.wait_for(future, timeout=30)
        finally:
            self.page.remove_listener("request", listener)

        task_info["prompt"] = prompt
        task_info["reference_image"] = str(reference_image) if reference_image else None
        self.store.upsert_pending(
            {
                "submit_id": task_info["submit_id"],
                "prompt": prompt,
                "reference_image": task_info["reference_image"],
                "mode": task_info["mode"],
                "created_at": now_iso(),
                "last_state": "submitted",
                "last_error": None,
            }
        )
        self.store.append_history(
            {
                "event": "submitted",
                "time": now_iso(),
                "submit_id": task_info["submit_id"],
                "mode": task_info["mode"],
                "prompt": prompt,
                "reference_image": task_info["reference_image"],
            }
        )
        return task_info

    async def fetch_submit_record(self, submit_id: str) -> dict[str, Any] | None:
        assert self.page is not None
        await self._prepare_page()
        raw = await self.page.evaluate(
            """async (sid) => {
                const resp = await fetch('/mweb/v1/get_history_by_ids', {
                    method: 'POST',
                    headers: {'content-type': 'application/json'},
                    body: JSON.stringify({submit_ids: [sid]}),
                });
                return {status: resp.status, text: await resp.text()};
            }""",
            submit_id,
        )
        if int(raw.get("status", 0)) != 200:
            raise RuntimeError(f"history api http {raw.get('status')}")
        payload = json.loads(raw["text"])
        data = payload.get("data") or {}
        return data.get(submit_id)

    @staticmethod
    def _classify_record(record: dict[str, Any] | None) -> str:
        if not record:
            return "missing"
        item_list = record.get("item_list") or []
        if item_list:
            return "completed"
        return "pending"

    @staticmethod
    def _pick_best_image_url(item: dict[str, Any]) -> str | None:
        image = item.get("image") or {}
        large_images = image.get("large_images") or []
        if large_images:
            scored = sorted(
                large_images,
                key=lambda obj: int(obj.get("width", 0)) * int(obj.get("height", 0)),
                reverse=True,
            )
            url = scored[0].get("image_url")
            if url:
                return str(url)

        common = item.get("common_attr") or {}
        cover_map = common.get("cover_url_map") or {}
        if cover_map:
            ranked = []
            for key, value in cover_map.items():
                try:
                    score = int(key)
                except ValueError:
                    score = 0
                ranked.append((score, str(value)))
            ranked.sort(key=lambda x: x[0], reverse=True)
            if ranked and ranked[0][1]:
                return ranked[0][1]

        cover_url = common.get("cover_url")
        if cover_url:
            return str(cover_url)
        return None

    @staticmethod
    def _guess_ext(url: str) -> str:
        match = re.search(r"format=\.([a-zA-Z0-9]+)", url)
        if match:
            return match.group(1).lower()
        match = re.search(r"\.([a-zA-Z0-9]{3,4})(?:\?|$)", url)
        if match:
            return match.group(1).lower()
        return "png"

    async def download_images(self, submit_id: str, prompt: str, record: dict[str, Any]) -> list[str]:
        assert self.page is not None
        item_list = record.get("item_list") or []
        if not item_list:
            return []

        task_dir = ensure_dir(self.config.downloads_dir / date.today().isoformat() / submit_id)
        downloaded_files: list[str] = []

        for idx, item in enumerate(item_list, start=1):
            image_url = self._pick_best_image_url(item)
            if not image_url:
                continue
            ext = self._guess_ext(image_url)
            target = task_dir / f"{idx:02d}.{ext}"
            if not target.exists():
                response = await self.page.request.get(image_url, timeout=120000)
                if not response.ok:
                    LOGGER.warning("download failed [%s]: %s", response.status, image_url)
                    continue
                target.write_bytes(await response.body())
            downloaded_files.append(str(target))

        metadata = {
            "submit_id": submit_id,
            "prompt": prompt,
            "downloaded_at": now_iso(),
            "item_count": len(item_list),
            "record_status": record.get("status"),
            "task_status": (record.get("task") or {}).get("status"),
            "files": downloaded_files,
        }
        (task_dir / "metadata.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return downloaded_files

    async def wait_and_download(
        self,
        submit_id: str,
        prompt: str,
        timeout_sec: int | None = None,
        poll_interval_sec: int | None = None,
    ) -> dict[str, Any]:
        timeout_sec = timeout_sec if timeout_sec is not None else self.config.wait_timeout_sec
        poll_interval_sec = (
            poll_interval_sec if poll_interval_sec is not None else self.config.poll_interval_sec
        )
        deadline = time.time() + max(timeout_sec, 1)

        while time.time() <= deadline:
            latest_record = await self.fetch_submit_record(submit_id)
            state = self._classify_record(latest_record)
            if state == "completed":
                files = await self.download_images(submit_id, prompt, latest_record or {})
                self.store.remove_pending(submit_id)
                self.store.append_history(
                    {
                        "event": "completed",
                        "time": now_iso(),
                        "submit_id": submit_id,
                        "prompt": prompt,
                        "downloaded_files": files,
                    }
                )
                return {
                    "state": "completed",
                    "submit_id": submit_id,
                    "prompt": prompt,
                    "downloaded_files": files,
                }
            if state == "failed":
                self.store.upsert_pending(
                    {
                        "submit_id": submit_id,
                        "prompt": prompt,
                        "created_at": now_iso(),
                        "last_state": "failed",
                        "last_error": "remote task marked as failed",
                    }
                )
                self.store.append_history(
                    {
                        "event": "failed",
                        "time": now_iso(),
                        "submit_id": submit_id,
                        "prompt": prompt,
                    }
                )
                return {
                    "state": "failed",
                    "submit_id": submit_id,
                    "prompt": prompt,
                    "downloaded_files": [],
                }
            await asyncio.sleep(max(poll_interval_sec, 1))

        self.store.upsert_pending(
            {
                "submit_id": submit_id,
                "prompt": prompt,
                "created_at": now_iso(),
                "last_state": "pending",
                "last_error": None,
            }
        )
        return {
            "state": "pending",
            "submit_id": submit_id,
            "prompt": prompt,
            "downloaded_files": [],
        }

    async def poll_pending_tasks(self, timeout_per_task_sec: int = 0) -> list[dict[str, Any]]:
        tasks = self.store.list_pending()
        results: list[dict[str, Any]] = []
        if not tasks:
            return results
        for task in tasks:
            submit_id = str(task.get("submit_id", "")).strip()
            prompt = str(task.get("prompt", "")).strip()
            if not submit_id:
                continue
            timeout = timeout_per_task_sec if timeout_per_task_sec > 0 else 1
            result = await self.wait_and_download(
                submit_id=submit_id,
                prompt=prompt or "(unknown prompt)",
                timeout_sec=timeout,
                poll_interval_sec=max(self.config.poll_interval_sec, 1),
            )
            results.append(result)
        return results


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="JiMeng image generation bot")
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    parser.add_argument("--chrome-data-dir", default=str(DEFAULT_CHROME_DATA_DIR))
    parser.add_argument("--cookie-file", default=str(DEFAULT_COOKIE_FILE))
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--headless", action="store_true", default=True)
    parser.add_argument("--headed", action="store_true", help="run browser in visible mode")
    parser.add_argument("--poll-interval", type=int, default=12, help="poll interval (seconds)")
    parser.add_argument("--wait-timeout", type=int, default=600, help="wait timeout (seconds)")
    parser.add_argument("--learn-time", default="09:00", help="daily learn time in HH:MM")
    parser.add_argument(
        "--log-level",
        default="WARNING",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    p_generate = subparsers.add_parser("generate", help="submit image prompt and auto download")
    p_generate.add_argument("--prompt", required=True)
    p_generate.add_argument("--reference", help="optional reference image path")
    p_generate.add_argument(
        "--no-wait",
        action="store_true",
        help="submit only, do not wait for completion",
    )

    p_submit = subparsers.add_parser("submit", help="submit prompt only")
    p_submit.add_argument("--prompt", required=True)
    p_submit.add_argument("--reference", help="optional reference image path")

    p_poll = subparsers.add_parser("poll", help="poll pending tasks and download completed images")
    p_poll.add_argument("--submit-id", help="poll one submit id")
    p_poll.add_argument("--timeout", type=int, default=60, help="timeout for this poll run (seconds)")

    subparsers.add_parser("learn", help="run daily prompt learning once")

    p_run = subparsers.add_parser("run", help="run daemon: periodic poll + daily learn")
    p_run.add_argument("--loop-interval", type=int, default=60, help="daemon loop interval in seconds")
    return parser


def parse_config(args: argparse.Namespace) -> BotConfig:
    headless = False if args.headed else bool(args.headless)
    return BotConfig(
        data_dir=Path(args.data_dir),
        chrome_data_dir=Path(args.chrome_data_dir),
        cookie_file=Path(args.cookie_file),
        base_url=args.base_url,
        headless=headless,
        poll_interval_sec=max(int(args.poll_interval), 1),
        wait_timeout_sec=max(int(args.wait_timeout), 1),
        daily_learn_time=args.learn_time,
    )


async def command_generate(config: BotConfig, args: argparse.Namespace) -> int:
    store = TaskStore(config)
    async with JiMengImageBot(config, store) as bot:
        task = await bot.submit_image_task(
            prompt=args.prompt.strip(),
            reference_image=Path(args.reference) if args.reference else None,
        )
        print(f"submitted: {task['submit_id']} (mode={task['mode']})")
        if task["mode"] != "image":
            print("warning: submit mode is not image, please check selector logic")
        if args.no_wait:
            return 0
        result = await bot.wait_and_download(
            submit_id=task["submit_id"],
            prompt=args.prompt.strip(),
            timeout_sec=config.wait_timeout_sec,
            poll_interval_sec=config.poll_interval_sec,
        )
    print(f"state: {result['state']}")
    if result["downloaded_files"]:
        print("downloaded:")
        for file_path in result["downloaded_files"]:
            print(f"- {file_path}")
    else:
        print("no files downloaded in this run (likely still pending)")
    return 0


async def command_submit(config: BotConfig, args: argparse.Namespace) -> int:
    store = TaskStore(config)
    async with JiMengImageBot(config, store) as bot:
        task = await bot.submit_image_task(
            prompt=args.prompt.strip(),
            reference_image=Path(args.reference) if args.reference else None,
        )
    print(f"submitted: {task['submit_id']} (mode={task['mode']})")
    return 0


async def command_poll(config: BotConfig, args: argparse.Namespace) -> int:
    store = TaskStore(config)
    async with JiMengImageBot(config, store) as bot:
        if args.submit_id:
            result = await bot.wait_and_download(
                submit_id=args.submit_id.strip(),
                prompt="",
                timeout_sec=max(int(args.timeout), 1),
                poll_interval_sec=config.poll_interval_sec,
            )
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        results = await bot.poll_pending_tasks(timeout_per_task_sec=max(int(args.timeout), 1))
        if not results:
            print("no pending tasks")
            return 0
        print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


def command_learn(config: BotConfig) -> int:
    store = TaskStore(config)
    learner = PromptLearner(store)
    output = learner.generate_daily_note()
    print(f"learning note generated: {output}")
    return 0


async def command_run(config: BotConfig, args: argparse.Namespace) -> int:
    store = TaskStore(config)
    learner = PromptLearner(store)
    loop_interval = max(int(args.loop_interval), 5)
    last_learn_date: date | None = None

    async with JiMengImageBot(config, store) as bot:
        while True:
            now = datetime.now()
            current_hm = now.strftime("%H:%M")
            if current_hm >= config.daily_learn_time and last_learn_date != now.date():
                path = learner.generate_daily_note()
                LOGGER.info("daily learning note generated: %s", path)
                last_learn_date = now.date()

            results = await bot.poll_pending_tasks(timeout_per_task_sec=1)
            if results:
                LOGGER.info("poll results: %s", json.dumps(results, ensure_ascii=False))
            await asyncio.sleep(loop_interval)


async def async_main(args: argparse.Namespace) -> int:
    config = parse_config(args)
    ensure_dir(config.data_dir)
    if args.command == "generate":
        return await command_generate(config, args)
    if args.command == "submit":
        return await command_submit(config, args)
    if args.command == "poll":
        return await command_poll(config, args)
    if args.command == "learn":
        return command_learn(config)
    if args.command == "run":
        return await command_run(config, args)
    raise RuntimeError(f"unsupported command: {args.command}")


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        return asyncio.run(async_main(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
