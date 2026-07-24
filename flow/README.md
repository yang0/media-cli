# Google Flow CLI

CLI for image generation in Google Flow through Chrome CDP.

```powershell
cd flow\cli
npm install
node flow.mjs "A cat sleeping in a sunny room"
```

Chrome must be running with remote debugging on port `9222` and signed in to Google Flow. Use `--ref-source file` with `--ref` for a local reference image.

The previous browser extension and video bridge were removed because they were not standalone CLI workflows.
