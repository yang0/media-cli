import argparse
import json
import sys
import urllib.request

import websocket


def pick_page(port):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=10) as response:
        pages = json.loads(response.read().decode("utf-8"))
    for page in pages:
        if page.get("type") == "page" and "labs.google" in page.get("url", ""):
            return page
    for page in pages:
        if page.get("type") == "page" and "flow.google" in page.get("url", ""):
            return page
    raise SystemExit("No Flow page found")


def evaluate(ws_url, expression, timeout=30):
    ws = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
    try:
        ws.send(json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
            },
        }))
        while True:
            message = json.loads(ws.recv())
            if message.get("id") == 1:
                return message
    finally:
        ws.close()


def call_method(ws_url, method, params=None, timeout=30):
    ws = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
    try:
        ws.send(json.dumps({
            "id": 1,
            "method": method,
            "params": params or {},
        }))
        while True:
            message = json.loads(ws.recv())
            if message.get("id") == 1:
                return message
    finally:
        ws.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9223)
    parser.add_argument("--expr")
    parser.add_argument("--file")
    parser.add_argument("--out")
    parser.add_argument("--method")
    parser.add_argument("--params", default="{}")
    parser.add_argument("--params-file")
    args = parser.parse_args()

    page = pick_page(args.port)
    if args.method:
        params = args.params
        if args.params_file:
            with open(args.params_file, "r", encoding="utf-8") as handle:
                params = handle.read()
        result = call_method(page["webSocketDebuggerUrl"], args.method, json.loads(params))
        output = json.dumps(result, ensure_ascii=False, indent=2)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(output)
                handle.write("\n")
            return
        sys.stdout.buffer.write(output.encode("utf-8"))
        sys.stdout.buffer.write(b"\n")
        return

    expression = args.expr
    if args.file:
        with open(args.file, "r", encoding="utf-8") as handle:
            expression = handle.read()
    if not expression:
        raise SystemExit("--expr or --file is required")

    result = evaluate(page["webSocketDebuggerUrl"], expression)
    output = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(output)
            handle.write("\n")
        return
    sys.stdout.buffer.write(output.encode("utf-8"))
    sys.stdout.buffer.write(b"\n")


if __name__ == "__main__":
    main()
