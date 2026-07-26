const { existsSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const webview = join(root, 'webview');
const venvPython = join(webview, '.venv', 'Scripts', 'python.exe');
const requested = process.env.DOLA_PYTHON || 'python';

function run(executable, args) {
  return spawnSync(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true });
}

if (existsSync(venvPython)) process.exit(0);
mkdirSync(webview, { recursive: true });
let result = run(requested, ['-m', 'venv', '.venv']);
if (result.error || result.status !== 0) {
  console.warn('[dola-cli] Python venv creation skipped; set DOLA_PYTHON to Python with pywebview installed.');
  process.exit(0);
}

const pip = join(webview, '.venv', 'Scripts', 'python.exe');
const requirements = join(webview, 'requirements.txt');
result = run(pip, ['-m', 'pip', 'install', '-r', requirements]);
if (result.error || result.status !== 0) {
  console.warn('[dola-cli] pywebview dependencies were not installed. Run:');
  console.warn(`  "${pip}" -m pip install -r "${requirements}"`);
  process.exit(0);
}
console.log('[dola-cli] WebView Python runtime is ready.');
