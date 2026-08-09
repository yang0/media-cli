import marshal
import types
from pathlib import Path


def walk(code, out, prefix=""):
    for c in code.co_consts:
        if isinstance(c, str):
            out.append((prefix + "STR", c))
        elif isinstance(c, types.CodeType):
            walk(c, out, prefix + code.co_name + ".")
    for n in code.co_names:
        out.append((prefix + "NAME", n))
    for n in getattr(code, "co_varnames", ()):
        out.append((prefix + "VAR", n))
    for n in getattr(code, "co_freevars", ()):
        out.append((prefix + "FREE", n))


base = Path(r"E:\projectHome\media-cli\dola\webview\free_protocol\__pycache__")
out_dir = Path(r"E:\projectHome\media-cli\dola\webview\_pyc_dump")
out_dir.mkdir(exist_ok=True)

for pyc in sorted(base.glob("*.pyc")):
    data = pyc.read_bytes()
    try:
        code = marshal.loads(data[16:])
    except Exception as e:
        print(pyc.name, "FAIL", e)
        continue
    items = []
    walk(code, items)
    text_lines = [f"# {pyc.name} filename={code.co_filename}", f"# co_names={code.co_names}", ""]
    for kind, val in items:
        if kind.endswith("STR"):
            text_lines.append(f"STR {val!r}")
        else:
            text_lines.append(f"{kind} {val}")
    (out_dir / (pyc.stem + ".txt")).write_text("\n".join(text_lines), encoding="utf-8")
    print("wrote", pyc.name, "items", len(items))

print("done")
