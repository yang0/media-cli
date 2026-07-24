import argparse
import base64
import json
import mimetypes
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def http_json(url, data=None):
    body = None
    headers = {}
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def read_text(url):
    with urllib.request.urlopen(url, timeout=10) as response:
        return response.read().decode("utf-8")


def image_to_data_url(path):
    image_path = Path(path).expanduser().resolve()
    if not image_path.exists():
        raise FileNotFoundError(image_path)
    mime = mimetypes.guess_type(str(image_path))[0] or "image/png"
    encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return image_path.name, f"data:{mime};base64,{encoded}"


def list_pages(port):
    return http_json(f"http://127.0.0.1:{port}/json")


def open_page(port, url):
    quoted = urllib.parse.quote(url, safe="")
    endpoint = f"http://127.0.0.1:{port}/json/new?{quoted}"
    request = urllib.request.Request(endpoint, method="PUT")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError:
        return http_json(endpoint)


def pick_flow_page(port, url):
    pages = list_pages(port)
    for page in pages:
        page_url = page.get("url", "")
        if page.get("type") == "page" and ("flow.google" in page_url or "labs.google" in page_url):
            return page
    return open_page(port, url)


def websocket_request(ws_url, payload, timeout=90):
    try:
        import websocket
    except ImportError as exc:
        raise RuntimeError("Missing dependency: pip install websocket-client") from exc

    ws = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
    try:
        ws.send(json.dumps(payload))
        deadline = time.time() + timeout
        while time.time() < deadline:
            raw = ws.recv()
            message = json.loads(raw)
            if message.get("id") == payload["id"]:
                return message
        raise TimeoutError("Timed out waiting for DevTools response")
    finally:
        ws.close()


def post_message_command(page, command, timeout_ms=85000):
    request_id = f"cli-{int(time.time() * 1000)}"
    command = dict(command)
    command["source"] = "flow-skill-bridge"
    command["requestId"] = request_id
    expression = """
new Promise((resolve) => {
  const requestId = %s;
  const timeout = setTimeout(() => {
    window.removeEventListener("message", onMessage);
    resolve({ ok: false, error: { message: "Timed out waiting for Flow Skill Bridge response" } });
  }, %d);
  function onMessage(event) {
    const data = event.data || {};
    if (event.source !== window) return;
    if (data.source !== "flow-skill-bridge") return;
    if (data.requestId !== requestId) return;
    if (data.type !== "result" && data.type !== "error") return;
    clearTimeout(timeout);
    window.removeEventListener("message", onMessage);
    resolve(data.type === "result" ? { ok: true, result: data.result } : { ok: false, error: data.error });
  }
  window.addEventListener("message", onMessage);
  window.postMessage(%s, "*");
})
""" % (json.dumps(request_id), timeout_ms, json.dumps(command))
    return websocket_request(page["webSocketDebuggerUrl"], {
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expression,
            "awaitPromise": True,
            "userGesture": True,
            "returnByValue": True,
        },
    }, timeout=max(90, int(timeout_ms / 1000) + 15))


def post_command(page, prompt, image_name, image_data_url, auto_generate):
    command = {
        "type": "generate-video",
        "prompt": prompt,
        "filename": image_name,
        "imageDataUrl": image_data_url,
        "autoGenerate": auto_generate,
    }
    return post_message_command(page, command)


def post_command_async(page, prompt, image_name, image_data_url, auto_generate):
    command = {
        "source": "flow-skill-bridge",
        "type": "generate-video",
        "requestId": f"cli-{int(time.time() * 1000)}",
        "prompt": prompt,
        "filename": image_name,
        "imageDataUrl": image_data_url,
        "autoGenerate": auto_generate,
    }
    expression = "window.postMessage(%s, '*'); true" % json.dumps(command)
    return websocket_request(page["webSocketDebuggerUrl"], {
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expression,
            "awaitPromise": False,
            "userGesture": True,
            "returnByValue": True,
        },
    }, timeout=20)


def wait_download(page, count, timeout_ms, folder, prefix, include_existing):
    command = {
        "type": "wait-and-download",
        "count": count,
        "timeoutMs": timeout_ms,
        "folder": folder,
        "prefix": prefix,
        "includeExisting": include_existing,
    }
    return post_message_command(page, command, timeout_ms + 10000)


def main():
    parser = argparse.ArgumentParser(description="Send prompt + image to Flow Skill Bridge.")
    parser.add_argument("--prompt")
    parser.add_argument("--image")
    parser.add_argument("--port", type=int, default=9222)
    parser.add_argument("--url", default="https://flow.google/")
    parser.add_argument("--no-generate", action="store_true")
    parser.add_argument("--async-submit", action="store_true", help="Post the command to the extension and return immediately.")
    parser.add_argument("--wait-download", action="store_true")
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--timeout-ms", type=int, default=30 * 60 * 1000)
    parser.add_argument("--folder", default="FlowSkillBridge")
    parser.add_argument("--prefix", default="flow_material")
    parser.add_argument("--new-only", action="store_true", help="Only download videos that appear after this command starts.")
    args = parser.parse_args()

    try:
        read_text(f"http://127.0.0.1:{args.port}/json/version")
    except urllib.error.URLError as exc:
        raise SystemExit(
            f"Cannot connect to Chrome DevTools on port {args.port}. "
            f"Start Chrome with --remote-debugging-port={args.port}."
        ) from exc

    page = pick_flow_page(args.port, args.url)

    if args.wait_download:
        result = wait_download(page, args.count, args.timeout_ms, args.folder, args.prefix, not args.new_only)
        image_name = None
    else:
        if not args.prompt or not args.image:
            raise SystemExit("--prompt and --image are required unless --wait-download is used")
        image_name, image_data_url = image_to_data_url(args.image)
        if args.async_submit:
            result = post_command_async(page, args.prompt, image_name, image_data_url, not args.no_generate)
        else:
            result = post_command(page, args.prompt, image_name, image_data_url, not args.no_generate)
    if "exceptionDetails" in result.get("result", {}):
        raise SystemExit(json.dumps(result, indent=2))
    if args.async_submit and not args.wait_download:
        print(json.dumps({
            "ok": True,
            "target": page.get("url"),
            "image": image_name,
            "asyncSubmit": True,
            "autoGenerate": not args.no_generate,
        }, indent=2))
        return
    value = result.get("result", {}).get("result", {}).get("value")
    if value and not value.get("ok"):
        raise SystemExit(json.dumps(value, indent=2))
    print(json.dumps({
        "ok": True,
        "target": page.get("url"),
        "image": image_name,
        "autoGenerate": False if args.wait_download else not args.no_generate,
        "bridgeResult": value,
    }, indent=2))


if __name__ == "__main__":
    main()
