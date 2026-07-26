# -*- coding: utf-8 -*-
"""
Simple account launcher for Dola WebView2 shell.

- Create / open per-account WebView profiles
- After manual Google login in WebView, export cookies to G:\\cookies\\dola
- Show remaining daily video credits next to each account (4/day; 5s=1 10s=2 15s=3)
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox, simpledialog

from daily_profile_usage import DAILY_CREDIT_LIMIT, get_balance

ROOT = Path(__file__).resolve().parent
PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
PYTHONW = ROOT / ".venv" / "Scripts" / "pythonw.exe"
SHELL = ROOT / "dola_webview.py"
INJECT_SHELL = ROOT / "inject_shell.py"
PROFILES = ROOT / "profiles"
COOKIE_OUT = Path(r"G:\cookies\dola")
STATE = ROOT / "accounts.json"


def py() -> str:
    return str(PYTHON if PYTHON.exists() else sys.executable)


def pyw() -> str:
    return str(PYTHONW if PYTHONW.exists() else py())


def launch_hidden(cmd: list[str], log_prefix: str) -> subprocess.Popen:
    logs_dir = ROOT / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = logs_dir / f"{log_prefix}_{stamp}.log"
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
    stream = log_path.open("a", encoding="utf-8")
    try:
        return subprocess.Popen(
            cmd,
            cwd=str(ROOT),
            creationflags=creation_flags,
            stdout=stream,
            stderr=subprocess.STDOUT,
        )
    finally:
        stream.close()


def load_meta() -> dict:
    if STATE.exists():
        try:
            return json.loads(STATE.read_text(encoding="utf-8")).get("accounts", {})
        except Exception:
            return {}
    return {}


def delete_account_data(account_id: str) -> dict:
    """Delete one account's cookie files, isolated WebView profile, and metadata."""
    account_id = (account_id or "").strip()
    if not account_id or any(ch in account_id for ch in ("/", "\\", "\0")):
        raise ValueError("invalid account id")

    removed: list[str] = []
    failures: list[str] = []

    profile_root = PROFILES.resolve()
    profile_path = (PROFILES / account_id).resolve()
    try:
        profile_path.relative_to(profile_root)
    except ValueError as exc:
        raise ValueError("profile path escaped profiles directory") from exc

    if profile_path.exists():
        try:
            if profile_path.is_symlink():
                profile_path.unlink()
            else:
                shutil.rmtree(profile_path)
            removed.append(str(profile_path))
        except Exception as exc:
            failures.append(f"profile: {exc}")

    if COOKIE_OUT.is_dir():
        cookie_root = COOKIE_OUT.resolve()
        for path in list(COOKIE_OUT.iterdir()):
            if not path.is_file() or account_id_from_cookie_file(path) != account_id:
                continue
            try:
                resolved = path.resolve()
                resolved.relative_to(cookie_root)
                resolved.unlink()
                removed.append(str(resolved))
            except Exception as exc:
                failures.append(f"cookie {path.name}: {exc}")

    if STATE.exists():
        try:
            state = json.loads(STATE.read_text(encoding="utf-8"))
            accounts = state.get("accounts")
            if isinstance(accounts, dict) and account_id in accounts:
                del accounts[account_id]
                temp = STATE.with_suffix(".json.tmp")
                temp.write_text(
                    json.dumps(state, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                temp.replace(STATE)
                removed.append(f"{STATE}::{account_id}")
        except Exception as exc:
            failures.append(f"accounts.json: {exc}")

    return {"account": account_id, "removed": removed, "failures": failures}


def cookie_path_for(account_id: str) -> Path:
    """Standard export path: G:\\cookies\\dola\\dola_<id>.txt"""
    return COOKIE_OUT / f"dola_{account_id}.txt"


def account_id_from_cookie_file(path: Path) -> str | None:
    """
    Map cookie filename → account id.
      dola_GlynisWilliams9z0h.txt → GlynisWilliams9z0h
      dola_1.txt                  → 1
    Ignore non-matching names.
    """
    name = path.name
    if not name.lower().endswith(".txt"):
        return None
    stem = path.stem  # dola_xxx
    if stem.lower().startswith("dola_"):
        aid = stem[5:]
    elif stem.lower().startswith("dola-"):
        aid = stem[5:]
    else:
        # bare account id.txt (rare)
        aid = stem
    aid = (aid or "").strip()
    return aid or None


def list_cookie_accounts(cookie_dir: Path = COOKIE_OUT) -> dict[str, Path]:
    """account_id → non-empty cookie file path under G:\\cookies\\dola."""
    out: dict[str, Path] = {}
    if not cookie_dir.is_dir():
        return out
    for p in cookie_dir.iterdir():
        if not p.is_file():
            continue
        if p.suffix.lower() != ".txt":
            continue
        try:
            if p.stat().st_size <= 0:
                continue
        except OSError:
            continue
        aid = account_id_from_cookie_file(p)
        if not aid:
            continue
        # Prefer standard dola_<id>.txt if duplicates
        prev = out.get(aid)
        if prev is None or p.name.lower().startswith("dola_"):
            out[aid] = p
    return out


def list_profile_accounts(profiles_dir: Path = PROFILES) -> list[str]:
    profiles_dir.mkdir(parents=True, exist_ok=True)
    return sorted([p.name for p in profiles_dir.iterdir() if p.is_dir()])


def ensure_profile(account_id: str, profiles_dir: Path = PROFILES) -> Path:
    """Create WebView profile dir if missing. Always returns the path."""
    account_id = (account_id or "").strip()
    if not account_id:
        raise ValueError("account_id is required")
    path = profiles_dir / account_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_profiles_for_accounts(names: list[str] | set[str], profiles_dir: Path = PROFILES) -> list[str]:
    """Ensure every listed account has a profile folder; return sorted ids."""
    out: list[str] = []
    for name in sorted({str(n).strip() for n in names if str(n).strip()}):
        ensure_profile(name, profiles_dir)
        out.append(name)
    return out


def list_accounts(*, ensure: bool = True) -> list[str]:
    """
    Union of:
      1) WebView profile folders under webview/profiles/
      2) Cookie files under G:\\cookies\\dola\\dola_*.txt
      3) Keys in accounts.json

    When ensure=True (default), missing profile dirs are created automatically.
    """
    names: set[str] = set()
    names.update(list_profile_accounts())
    names.update(list_cookie_accounts().keys())
    names.update(load_meta().keys())
    ordered = sorted(names)
    if ensure:
        ordered = ensure_profiles_for_accounts(ordered)
    return ordered


def account_flags(account_id: str, meta: dict | None = None) -> str:
    """Human status for list row (cookie/session only — never 'no profile')."""
    meta = meta if meta is not None else load_meta()
    m = meta.get(account_id) or {}
    ck = cookie_path_for(account_id)
    cookie_map = list_cookie_accounts()
    has_cookie = False
    try:
        has_cookie = (ck.is_file() and ck.stat().st_size > 0) or account_id in cookie_map
    except OSError:
        has_cookie = account_id in cookie_map

    if m.get("hasSession") or has_cookie:
        # Prefer session label when export meta says so
        if m.get("hasSession"):
            return "✓session"
        return "✓cookie"
    return "未导出"


def credit_label(account_id: str) -> str:
    """e.g. '积分 3/4' — remaining daily video credits."""
    try:
        bal = get_balance(account_id)
        rem = int(bal.get("remaining") or 0)
        lim = int(bal.get("limit") or DAILY_CREDIT_LIMIT)
        return f"积分 {rem}/{lim}"
    except Exception:
        return f"积分 ?/{DAILY_CREDIT_LIMIT}"


def format_account_row(name: str, flag: str) -> str:
    # Fixed-ish columns: name | credits | session flag
    # leave a clear slot after the name for remaining credits
    name_col = f"{name:<22}"
    credit_col = f"{credit_label(name):<10}"
    return f"{name_col}  {credit_col}  [{flag}]"


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Dola WebView 账号管理")
        self.geometry("640x460")
        self.minsize(560, 380)

        tk.Label(
            self,
            text="用 WebView2（Edge）登录 dola，比整站 Chrome 少很多浏览器弹窗。\n"
            "账号来源 = G:\\cookies\\dola\\dola_*.txt ∪ profiles/ ∪ accounts.json（缺 profile 会自动创建）\n"
            "流程：选账号 → 打开注入壳 / 登录导出 Cookie\n"
            f"视频积分：每号每天 {DAILY_CREDIT_LIMIT} 点（5s=1 / 10s=2 / 15s=3），「积分 剩/总」为今日剩余",
            justify="left",
            anchor="w",
        ).pack(fill="x", padx=12, pady=10)

        # Column header for the account list
        header = tk.Frame(self)
        header.pack(fill="x", padx=12, pady=(0, 2))
        tk.Label(header, text="账号", width=22, anchor="w", font=("Consolas", 9, "bold")).pack(side="left")
        tk.Label(header, text="今日剩余积分", width=12, anchor="w", font=("Consolas", 9, "bold")).pack(side="left", padx=(8, 0))
        tk.Label(header, text="状态", anchor="w", font=("Consolas", 9, "bold")).pack(side="left", padx=(8, 0))

        frame = tk.Frame(self)
        frame.pack(fill="both", expand=True, padx=12, pady=4)

        self.listbox = tk.Listbox(frame, height=14, font=("Consolas", 10))
        self.listbox.pack(side="left", fill="both", expand=True)
        sb = tk.Scrollbar(frame, command=self.listbox.yview)
        sb.pack(side="right", fill="y")
        self.listbox.config(yscrollcommand=sb.set)
        self.listbox.bind("<Double-Button-1>", lambda _e: self.open_inject())

        btns = tk.Frame(self)
        btns.pack(fill="x", padx=12, pady=10)
        tk.Button(btns, text="重新打开账号 WebView", command=self.open_account_webview).pack(side="left", padx=4)
        tk.Button(btns, text="刷新", command=self.refresh).pack(side="left", padx=4)
        tk.Button(btns, text="新建账号", command=self.create).pack(side="left", padx=4)
        tk.Button(btns, text="删除账号", command=self.delete_selected).pack(side="left", padx=4)
        tk.Button(btns, text="打开注入壳", command=self.open_inject).pack(side="left", padx=4)
        tk.Button(btns, text="用 google_mail 自动登录", command=self.auto_login_from_file).pack(side="left", padx=4)
        tk.Button(btns, text="打开 Cookie 目录", command=self.open_cookie_dir).pack(side="left", padx=4)

        batch_btns = tk.Frame(self)
        batch_btns.pack(fill="x", padx=12, pady=(0, 8))
        tk.Button(
            batch_btns,
            text="选择 Gmail 文本批量导出 Cookie",
            command=self.batch_export_from_file,
        ).pack(side="left", padx=4)

        self.status = tk.StringVar(value=f"Cookie 导出目录: {COOKIE_OUT}  |  双击账号可开注入壳")
        tk.Label(self, textvariable=self.status, anchor="w").pack(fill="x", padx=12, pady=(0, 10))

        self.refresh()

    def refresh(self) -> None:
        self.listbox.delete(0, tk.END)
        meta = load_meta()
        # list_accounts(ensure=True) auto-creates missing profile dirs
        names = list_accounts(ensure=True)
        cookie_map = list_cookie_accounts()
        for name in names:
            flag = account_flags(name, meta)
            self.listbox.insert(tk.END, format_account_row(name, flag))
        if not names:
            self.listbox.insert(tk.END, "(还没有账号：请放 cookie 到 G:\\cookies\\dola 或点「新建账号」)")
        else:
            try:
                total_rem = 0
                for name in names:
                    total_rem += int(get_balance(name).get("remaining") or 0)
                n_ck = len(cookie_map)
                self.status.set(
                    f"Cookie: {COOKIE_OUT} ({n_ck} 文件)  |  账号 {len(names)} 个  |  "
                    f"今日剩余积分合计 {total_rem}  "
                    f"(上限{DAILY_CREDIT_LIMIT}/号 · 5s=1 10s=2 15s=3)"
                )
            except Exception as exc:
                self.status.set(f"刷新异常: {exc}")

    def selected_id(self) -> str | None:
        sel = self.listbox.curselection()
        if not sel:
            return None
        text = self.listbox.get(sel[0])
        if text.startswith("("):
            return None
        return text.split()[0]

    def create(self) -> None:
        name = simpledialog.askstring("新建账号", "账号 id（仅字母数字下划线）:", parent=self)
        if not name:
            return
        safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name.strip())
        if not safe:
            messagebox.showerror("错误", "无效账号 id")
            return
        (PROFILES / safe).mkdir(parents=True, exist_ok=True)
        self.refresh()
        self.status.set(f"已创建 profile: {safe}")

    def delete_selected(self) -> None:
        acc = self.selected_id()
        if not acc:
            messagebox.showinfo("提示", "请先选择要删除的账号。", parent=self)
            return
        cookie_files = [
            p
            for p in (COOKIE_OUT.iterdir() if COOKIE_OUT.is_dir() else [])
            if p.is_file() and account_id_from_cookie_file(p) == acc
        ]
        profile_path = PROFILES / acc
        targets = []
        if cookie_files:
            targets.append("Cookie: " + ", ".join(p.name for p in cookie_files))
        if profile_path.exists():
            targets.append(f"Profile: {profile_path}")
        if acc in load_meta():
            targets.append("accounts.json 中的账号记录")
        detail = "\n".join(targets) if targets else "没有找到 Cookie 或 profile，仅从列表记录中清理。"
        if not messagebox.askyesno(
            "确认删除账号",
            f"确定删除账号“{acc}”吗？\n\n{detail}\n\n此操作不可撤销，请先关闭该账号的 WebView 窗口。",
            parent=self,
        ):
            return
        result = delete_account_data(acc)
        self.refresh()
        failures = result.get("failures") or []
        if failures:
            messagebox.showerror(
                "删除未完全成功",
                f"账号 {acc} 部分内容删除失败：\n" + "\n".join(failures),
                parent=self,
            )
            self.status.set(f"账号 {acc} 删除不完整，请关闭对应 WebView 后重试")
        else:
            self.status.set(f"已删除账号 {acc} 的 Cookie、profile 和列表记录")

    def open_inject(self) -> None:
        acc = self.selected_id()
        if not acc:
            messagebox.showinfo("提示", "请先选择一个账号")
            return
        if not INJECT_SHELL.exists():
            messagebox.showerror("错误", f"找不到注入壳: {INJECT_SHELL}")
            return
        # Always ensure profile exists (no user-facing "no profile" warnings)
        ensure_profile(acc)

        # Preflight: avoid silent flash-exit when neither profile nor cookie file has session
        try:
            from cookie_util import (
                filter_dola_related,
                find_account_cookie_file,
                has_session,
                load_account_netscape_cookies,
                load_cookies_from_webview2_profile,
            )

            storage = PROFILES / acc
            profile_ck = load_cookies_from_webview2_profile(storage)
            profile_ok = has_session(filter_dola_related(profile_ck) or profile_ck)
            file_ck = load_account_netscape_cookies(acc, COOKIE_OUT)
            file_ok = has_session(filter_dola_related(file_ck) or file_ck)
            ck_path = find_account_cookie_file(acc, COOKIE_OUT)
            if not profile_ok and not file_ok:
                messagebox.showerror(
                    "无法打开注入壳",
                    f"账号 {acc} 没有可用登录态。\n\n"
                    f"WebView profile 无 session\n"
                    f"Cookie 文件: {ck_path or (COOKIE_OUT / f'dola_{acc}.txt')} 无效或不存在\n\n"
                    "请把有效的 dola_<账号>.txt 放到 G:\\cookies\\dola，\n"
                    "或使用「用 google_mail 自动登录」重新导出。",
                )
                self.status.set(f"注入壳未启动: {acc} 无 session")
                return
            if not profile_ok and file_ok:
                self.status.set(f"启动注入壳: {acc}（将从 cookie 文件导入登录态）")
            else:
                self.status.set(f"启动注入壳: {acc}  ({credit_label(acc)})")
        except Exception as exc:
            # non-fatal preflight failure — still try launch
            self.status.set(f"启动注入壳: {acc}  (preflight warn: {exc})")

        cmd = [
            pyw(),
            "-u",
            str(INJECT_SHELL),
            "--account",
            acc,
            "--profiles",
            str(PROFILES),
            "--url",
            "https://www.dola.com/chat",
            "--out",
            str(ROOT.parent / "cli" / "downloads" / "inject"),
            "--log-dir",
            str(ROOT / "logs"),
        ]
        launch_hidden(cmd, f"inject_{acc}")

    def open_account_webview(self) -> None:
        """Open the selected account's normal WebView using its isolated profile."""
        acc = self.selected_id()
        if not acc:
            messagebox.showinfo("提示", "请先选择一个账号", parent=self)
            return
        ensure_profile(acc)
        cmd = [
            pyw(),
            "-u",
            str(SHELL),
            "--account",
            acc,
            "--profiles",
            str(PROFILES),
            "--out",
            str(COOKIE_OUT),
            "--url",
            "https://www.dola.com/chat",
        ]
        launch_hidden(cmd, f"account_{acc}")
        self.status.set(f"已重新打开账号 WebView: {acc}")

    def auto_login_from_file(self) -> None:
        accounts = ROOT.parent / "google_mail.txt"
        if not accounts.exists():
            messagebox.showerror("错误", f"找不到账号文件：{accounts}")
            return
        idx = simpledialog.askinteger("账号序号", "google_mail.txt 行号（从 0 开始）:", parent=self, minvalue=0, initialvalue=0)
        if idx is None:
            return
        cmd = [
            pyw(),
            str(SHELL),
            "--accounts",
            str(accounts),
            "--index",
            str(idx),
            "--auto-login",
            "--auto-export",
            "--profiles",
            str(PROFILES),
            "--out",
            str(COOKIE_OUT),
            "--login-timeout",
            "300",
        ]
        self.status.set(f"自动登录 google_mail[{idx}]（先登录，成功后再导出 cookie）")
        launch_hidden(cmd, f"login_{idx}")

    def batch_export_from_file(self) -> None:
        selected = filedialog.askopenfilename(
            title="选择 Gmail 账号文本",
            initialdir=str(ROOT.parent),
            filetypes=[("文本文件", "*.txt"), ("所有文件", "*.*")],
            parent=self,
        )
        if not selected:
            return
        accounts_file = Path(selected).resolve()
        try:
            from batch_export import account_id_from_email, exported_cookie
            from login_flow import parse_accounts_file

            rows = parse_accounts_file(str(accounts_file))
        except Exception as exc:
            messagebox.showerror("账号文件无效", f"无法读取 {accounts_file}：\n{exc}", parent=self)
            return
        if not rows:
            messagebox.showinfo("没有账号", "选择的文件中没有有效 Gmail 账号。", parent=self)
            return

        account_ids = list(dict.fromkeys(account_id_from_email(email) for email, _ in rows))
        existing = [name for name in account_ids if exported_cookie(COOKIE_OUT, name)]
        pending = [name for name in account_ids if name not in existing]
        if not pending:
            messagebox.showinfo(
                "无需导出",
                f"文件中 {len(account_ids)} 个账号都已有 Cookie，已全部跳过。",
                parent=self,
            )
            self.status.set(f"{accounts_file.name}: 全部 {len(account_ids)} 个账号已有 Cookie")
            return
        if not messagebox.askyesno(
            "确认批量导出",
            f"账号文件：{accounts_file}\n\n"
            f"有效账号：{len(account_ids)}\n"
            f"已有 Cookie，跳过：{len(existing)}\n"
            f"需要登录导出：{len(pending)}\n\n"
            "是否开始？每个账号会使用独立 WebView profile。",
            parent=self,
        ):
            return

        cmd = [
            pyw(),
            "-u",
            str(ROOT / "batch_export.py"),
            "--accounts",
            str(accounts_file),
            "--out",
            str(COOKIE_OUT),
            "--profiles",
            str(PROFILES),
            "--login-timeout",
            "300",
        ]
        launch_hidden(cmd, f"batch_export_{accounts_file.stem}")
        self.status.set(
            f"正在处理 {accounts_file.name}: 待导出 {len(pending)}，跳过 {len(existing)}"
        )

    def open_cookie_dir(self) -> None:
        COOKIE_OUT.mkdir(parents=True, exist_ok=True)
        subprocess.Popen(["explorer", str(COOKIE_OUT)])

def main() -> int:
    if not SHELL.exists():
        print("missing dola_webview.py", file=sys.stderr)
        return 1
    app = App()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
