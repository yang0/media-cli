# -*- coding: utf-8 -*-
"""
Detailed file + console logging for Dola WebView inject shell / video flow.

Log files go to webview/logs/ by default, e.g.:
  logs/inject_shell_20260725_153012.log

Usage:
  from debug_log import setup_logging, log, log_exc, get_log_path

  setup_logging("inject_shell")
  log("starting…")
"""
from __future__ import annotations

import atexit
import logging
import os
import platform
import sys
import threading
import traceback
from datetime import datetime
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent
DEFAULT_LOG_DIR = ROOT / "logs"

_logger: Optional[logging.Logger] = None
_log_path: Optional[Path] = None
_started_at: Optional[datetime] = None


def get_log_path() -> Optional[Path]:
    return _log_path


def get_logger() -> logging.Logger:
    global _logger
    if _logger is None:
        # Fallback: console-only until setup_logging is called
        setup_logging("dola", to_file=False)
    assert _logger is not None
    return _logger


def setup_logging(
    name: str = "inject_shell",
    *,
    log_dir: Path | str | None = None,
    to_file: bool = True,
    level: int = logging.DEBUG,
    also_console: bool = True,
) -> Path | None:
    """
    Configure root dola logger. Returns log file path (or None if to_file=False).
    Safe to call once; subsequent calls only add a note if already configured.
    """
    global _logger, _log_path, _started_at

    if _logger is not None and _log_path is not None and to_file:
        _logger.info("setup_logging called again (already active) path=%s", _log_path)
        return _log_path

    _started_at = datetime.now()
    logger = logging.getLogger("dola")
    logger.handlers.clear()
    logger.setLevel(level)
    logger.propagate = False

    fmt = logging.Formatter(
        fmt="%(asctime)s.%(msecs)03d [%(levelname)s] [%(threadName)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    path: Path | None = None
    if to_file:
        base = Path(log_dir) if log_dir else DEFAULT_LOG_DIR
        base.mkdir(parents=True, exist_ok=True)
        stamp = _started_at.strftime("%Y%m%d_%H%M%S")
        path = base / f"{name}_{stamp}.log"
        # also keep a rolling "latest" pointer for convenience
        latest = base / f"{name}_latest.log"
        fh = logging.FileHandler(path, encoding="utf-8", delay=False)
        fh.setLevel(level)
        fh.setFormatter(fmt)
        logger.addHandler(fh)
        # symlink/copy latest: write a small pointer file
        try:
            latest.write_text(str(path) + "\n", encoding="utf-8")
        except Exception:
            pass
        _log_path = path

    if also_console:
        # Windows terminals commonly expose a GBK stream. Keep console logging
        # from raising UnicodeEncodeError on UI glyphs such as the download icon;
        # the UTF-8 file handler still preserves the original text.
        try:
            if hasattr(sys.stdout, "reconfigure"):
                sys.stdout.reconfigure(errors="backslashreplace")
        except Exception:
            pass
        ch = logging.StreamHandler(sys.stdout)
        ch.setLevel(logging.INFO)
        ch.setFormatter(
            logging.Formatter(fmt="[dola] %(asctime)s %(message)s", datefmt="%H:%M:%S")
        )
        logger.addHandler(ch)

    _logger = logger

    # Process-level hooks so crashes still land in the file
    def _excepthook(exc_type, exc, tb):
        try:
            logger.error(
                "UNCAUGHT EXCEPTION\n%s",
                "".join(traceback.format_exception(exc_type, exc, tb)),
            )
        except Exception:
            pass
        # still print default
        sys.__excepthook__(exc_type, exc, tb)

    sys.excepthook = _excepthook

    if hasattr(threading, "excepthook"):

        def _thread_excepthook(args):  # type: ignore[no-untyped-def]
            try:
                logger.error(
                    "UNCAUGHT THREAD EXCEPTION thread=%s\n%s",
                    getattr(args, "thread", None),
                    "".join(
                        traceback.format_exception(
                            args.exc_type, args.exc_value, args.exc_traceback
                        )
                    ),
                )
            except Exception:
                pass

        threading.excepthook = _thread_excepthook  # type: ignore[assignment]

    def _atexit():
        try:
            elapsed = ""
            if _started_at:
                elapsed = f" elapsed={(datetime.now() - _started_at).total_seconds():.1f}s"
            logger.info("=== process exit%s ===", elapsed)
            for h in list(logger.handlers):
                try:
                    h.flush()
                except Exception:
                    pass
        except Exception:
            pass

    atexit.register(_atexit)

    logger.info("=== log start name=%s file=%s ===", name, path or "(console-only)")
    return path


def log_env(extra: dict | None = None) -> None:
    """Dump environment useful for debugging open/close issues."""
    lg = get_logger()
    try:
        import webview as _wv

        wv_ver = getattr(_wv, "__version__", None)
        if not wv_ver:
            try:
                from importlib.metadata import version as _pkg_version

                wv_ver = _pkg_version("pywebview")
            except Exception:
                wv_ver = f"module={getattr(_wv, '__file__', '?')}"
    except Exception as exc:
        wv_ver = f"import-failed:{exc}"

    lg.info("--- environment ---")
    lg.info("python=%s", sys.version.replace("\n", " "))
    lg.info("executable=%s", sys.executable)
    lg.info("platform=%s", platform.platform())
    lg.info("cwd=%s", os.getcwd())
    lg.info("argv=%s", sys.argv)
    lg.info("pid=%s ppid=%s", os.getpid(), os.getppid() if hasattr(os, "getppid") else "?")
    lg.info("pywebview=%s", wv_ver)
    lg.info("ROOT=%s", ROOT)
    if extra:
        for k, v in extra.items():
            lg.info("%s=%s", k, v)
    lg.info("--- /environment ---")


def log(msg: str, level: int = logging.INFO) -> None:
    """Primary log helper — also mirrors the old dola_webview.log style."""
    get_logger().log(level, msg)
    # flush file handlers immediately so crash mid-run still leaves a trail
    for h in get_logger().handlers:
        try:
            h.flush()
        except Exception:
            pass


def log_debug(msg: str) -> None:
    log(msg, logging.DEBUG)


def log_warn(msg: str) -> None:
    log(msg, logging.WARNING)


def log_error(msg: str) -> None:
    log(msg, logging.ERROR)


def log_exc(msg: str = "exception", exc: BaseException | None = None) -> None:
    lg = get_logger()
    if exc is not None:
        lg.error("%s: %s\n%s", msg, exc, traceback.format_exc())
    else:
        lg.error("%s\n%s", msg, traceback.format_exc())
    for h in lg.handlers:
        try:
            h.flush()
        except Exception:
            pass


def log_step(step: str, detail: str = "") -> None:
    if detail:
        log(f">>> {step}: {detail}")
    else:
        log(f">>> {step}")
