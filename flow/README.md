# Google Flow CLI

CLI for image and image-to-video generation in Google Flow through Chrome CDP.

```powershell
cd flow\cli
npm install
node flow.mjs "A cat sleeping in a sunny room" --port 9221
node flow.mjs --video --ref E:\temp\avatar.webp --ref-source file `
  --duration 8 --aspect 16:9 --port 9221 `
  "The subject slowly turns toward the camera"
```

Chrome must be running with remote debugging on port `9221` and signed in to Google Flow. Video mode inserts random 1–3 second pauses between major actions.

Video output is saved as `.mp4` under `downloads/` by default. Supported durations are 4s, 6s, 8s, and 10s. `ffmpeg` must be available on `PATH`; the CLI extracts the first frame and rejects a result that is visually unrelated to the local reference image.
