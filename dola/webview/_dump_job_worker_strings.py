from pathlib import Path
import marshal
import types

data = Path(r"E:\projectHome\media-cli\dola\webview\__pycache__\job_worker.cpython-313.pyc").read_bytes()
code = marshal.loads(data[16:])


def walk(c, out, name=""):
    for x in c.co_consts:
        if isinstance(x, str) and len(x) > 2:
            out.append((name, x))
        elif isinstance(x, types.CodeType):
            walk(x, out, x.co_name)


items = []
walk(code, items)
keys = (
    "free_protocol",
    "http-external",
    "generate",
    "--file",
    "refs",
    "cli",
    "video",
    "out",
    "wait",
    "account",
    "duration",
    "aspect",
    "mode=",
    "-m",
)
for n, s in items:
    if any(k in s for k in keys):
        print(f"{n}: {s[:260]!r}")
