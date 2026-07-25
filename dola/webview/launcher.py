# -*- coding: utf-8 -*-
"""
Simple account launcher for Dola WebView2 shell.

- Create / open per-account WebView profiles
- After manual Google login in WebView, export cookies to G:\\cookies\\dola
"""
from __future__ import annotations

import json
import subprocess
import sys
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, simpledialog

ROOT = Path(__file__).resolve().parent
PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
SHELL = ROOT / "dola_webview.py"
PROFILES = ROOT / "profiles"
COOKIE_OUT = Path(r"G:\cookies\dola")
STATE = ROOT / "accounts.json"


def py() -> str:
    return str(PYTHON if PYTHON.exists() else sys.executable)


def list_accounts() -> list[str]:
    PROFILES.mkdir(parents=True, exist_ok=True)
    return sorted([p.name for p in PROFILES.iterdir() if p.is_dir()])


def load_meta() -> dict:
    if STATE.exists():
        try:
            return json.loads(STATE.read_text(encoding="utf-8")).get("accounts", {})
        except Exception:
            return {}
    return {}


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Dola WebView 账号管理")
        self.geometry("520x420")
        self.minsize(480, 360)

        tk.Label(
            self,
            text="用 WebView2（Edge）登录 dola，比整站 Chrome 少很多浏览器弹窗。\n"
            "流程：选账号 → 打开 → 手动 Continue with Google → 菜单导出 Cookie",
            justify="left",
            anchor="w",
        ).pack(fill="x", padx=12, pady=10)

        frame = tk.Frame(self)
        frame.pack(fill="both", expand=True, padx=12, pady=4)

        self.listbox = tk.Listbox(frame, height=14)
        self.listbox.pack(side="left", fill="both", expand=True)
        sb = tk.Scrollbar(frame, command=self.listbox.yview)
        sb.pack(side="right", fill="y")
        self.listbox.config(yscrollcommand=sb.set)

        btns = tk.Frame(self)
        btns.pack(fill="x", padx=12, pady=10)
        tk.Button(btns, text="刷新", command=self.refresh).pack(side="left", padx=4)
        tk.Button(btns, text="新建账号", command=self.create).pack(side="left", padx=4)
        tk.Button(btns, text="打开 WebView 登录", command=self.open_account).pack(side="left", padx=4)
        tk.Button(btns, text="用 google_mail 自动登录", command=self.auto_login_from_file).pack(side="left", padx=4)
        tk.Button(btns, text="批量导出未导出账号", command=self.batch_export).pack(side="left", padx=4)
        tk.Button(btns, text="打开 Cookie 目录", command=self.open_cookie_dir).pack(side="left", padx=4)

        self.status = tk.StringVar(value=f"Cookie 导出目录: {COOKIE_OUT}")
        tk.Label(self, textvariable=self.status, anchor="w").pack(fill="x", padx=12, pady=(0, 10))

        self.refresh()

    def refresh(self) -> None:
        self.listbox.delete(0, tk.END)
        meta = load_meta()
        for name in list_accounts():
            m = meta.get(name) or {}
            flag = "✓session" if m.get("hasSession") else ("cookie" if m.get("cookieFile") else "未导出")
            self.listbox.insert(tk.END, f"{name}  [{flag}]")
        if not list_accounts():
            self.listbox.insert(tk.END, "(还没有账号，点「新建账号」)")

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

    def open_account(self) -> None:
        acc = self.selected_id()
        if not acc:
            messagebox.showinfo("提示", "请先选择或新建一个账号")
            return
        cmd = [
            py(),
            str(SHELL),
            "--account",
            acc,
            "--profiles",
            str(PROFILES),
            "--out",
            str(COOKIE_OUT),
        ]
        self.status.set(f"启动 WebView: {acc}")
        # Detach so launcher stays usable
        subprocess.Popen(cmd, cwd=str(ROOT))

    def auto_login_from_file(self) -> None:
        accounts = ROOT.parent / "google_mail.txt"
        if not accounts.exists():
            messagebox.showerror("错误", f"找不到账号文件：{accounts}")
            return
        idx = simpledialog.askinteger("账号序号", "google_mail.txt 行号（从 0 开始）:", parent=self, minvalue=0, initialvalue=0)
        if idx is None:
            return
        cmd = [
            py(),
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
        subprocess.Popen(cmd, cwd=str(ROOT))

    def open_cookie_dir(self) -> None:
        COOKIE_OUT.mkdir(parents=True, exist_ok=True)
        subprocess.Popen(["explorer", str(COOKIE_OUT)])

    def batch_export(self) -> None:
        accounts = ROOT.parent / "google_mail.txt"
        if not accounts.exists():
            messagebox.showerror("错误", f"找不到账号文件：{accounts}")
            return
        if not messagebox.askyesno(
            "批量导出",
            "将顺序处理 google_mail.txt 中尚未导出的账号。\n"
            "G:\\cookies\\dola 中已有的非空 Cookie 文件会跳过。",
            parent=self,
        ):
            return
        cmd = [
            py(), str(ROOT / "batch_export.py"),
            "--accounts", str(accounts), "--out", str(COOKIE_OUT),
            "--profiles", str(PROFILES),
        ]
        self.status.set("正在批量处理未导出账号；每个账号完成后会自动继续下一个。")
        subprocess.Popen(cmd, cwd=str(ROOT))


def main() -> int:
    if not SHELL.exists():
        print("missing dola_webview.py", file=sys.stderr)
        return 1
    app = App()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
