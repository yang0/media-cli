# Flow Skill Bridge

Scriptable Chrome extension for Google Flow image-to-video generation.

The extension listens on Flow pages for `window.postMessage` commands containing a prompt and an image data URL. The helper script sends that command through Chrome DevTools Protocol, so you can drive the already logged-in Chrome profile.

## Install

1. Close existing Chrome windows if they were not started with remote debugging. Then open Chrome with the target profile and this unpacked extension:

   ```powershell
   .\scripts\launch_profile3_debug.ps1
   ```

   Or run Chrome manually:

   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" `
     --remote-debugging-port=9222 `
     --profile-directory="Profile 3" `
     --load-extension="C:\Users\yang0\AppData\Local\Google\Chrome\User Data\Profile 3\FlowSkillBridge" `
     "https://flow.google/"
   ```

2. If you prefer manual installation, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder:

   ```text
   C:\Users\yang0\AppData\Local\Google\Chrome\User Data\Profile 3\FlowSkillBridge
   ```

3. Open Google Flow in that Chrome window if it is not already open:

   ```text
   https://flow.google/
   ```

## Send a prompt and image

```powershell
python .\scripts\send_flow_request.py `
  --prompt "A slow cinematic dolly shot of the subject, soft morning light" `
  --image "E:\path\to\input.png"
```

Options:

- `--port 9222`: Chrome DevTools port.
- `--url https://flow.google/`: page URL to open if no Flow tab exists.
- `--no-generate`: upload the image and fill the prompt, but do not click Generate.

## Notes

The extension intentionally waits for image upload acknowledgement before filling the prompt and clicking Generate. That is the guardrail that prevents a failed image selection from silently becoming text-to-video.
