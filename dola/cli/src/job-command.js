import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JOB_CLI = path.resolve(HERE, '..', '..', 'webview', 'job_cli.py');
const PACKAGE_ROOT = path.resolve(HERE, '..', '..');
const JOB_RESOURCES = new Set(['video', 'jobs', 'pool', 'worker', 'account']);

function isInstalledPackage() {
  return PACKAGE_ROOT.split(path.sep).includes('node_modules');
}

function pythonExecutable() {
  if (process.env.DOLA_PYTHON) return process.env.DOLA_PYTHON;
  const bundled = path.resolve(HERE, '..', '..', 'webview', '.venv', 'Scripts', 'python.exe');
  return existsSync(bundled) ? bundled : 'python';
}

function runPython(args) {
  const env = {
    ...process.env,
    // Job artifacts belong to the caller, even when the CLI is installed globally.
    DOLA_JOBS_ROOT: process.env.DOLA_JOBS_ROOT || path.join(process.cwd(), 'downloads', 'jobs'),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  if (isInstalledPackage() && !env.DOLA_DATA_DIR) {
    const dataRoot = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'dola-cli')
      : path.join(process.env.HOME || process.cwd(), '.local', 'share', 'dola-cli');
    env.DOLA_DATA_DIR = dataRoot;
  }
  const result = spawnSync(pythonExecutable(), [JOB_CLI, ...args], {
    // Keep the caller's working directory so portable job artifacts land in
    // ./downloads/jobs instead of inside the global npm installation.
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}

function removeJsonFlag(args) {
  return args.filter(arg => arg !== '--json');
}

function legacyValue(args, index) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${args[index]}`);
  return value;
}

function translateLegacyVideo(args) {
  const action = args.includes('--no-wait') ? 'submit' : 'generate';
  const out = ['video', action];
  const passthrough = new Map([
    ['--prompt', '--prompt'],
    ['--prompt-file', '--prompt-file'],
    ['--duration', '--duration'],
    ['--video-duration', '--duration'],
    ['--model', '--model'],
    ['--video-model', '--model'],
    ['--aspect-ratio', '--aspect-ratio'],
    ['--ratio', '--aspect-ratio'],
    ['--file', '--file'],
    ['--attach', '--file'],
    ['--reference-image', '--file'],
    ['--account-id', '--account'],
    ['--account-pool', '--account-pool'],
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (passthrough.has(arg)) {
      const value = legacyValue(args, i);
      out.push(passthrough.get(arg), value);
      i += 1;
    } else if (arg === '--out') {
      out.push('--out-root', legacyValue(args, i));
      i += 1;
    } else if (arg === '--timeout') {
      out.push('--timeout', `${legacyValue(args, i)}ms`);
      i += 1;
    }
  }
  return out;
}

export function handleJobCommand(argv) {
  const args = argv.slice(2);
  if (JOB_RESOURCES.has(args[0])) {
    runPython(removeJsonFlag(args));
    return true;
  }
  const legacyVideo = args.includes('--video-gen') || args.includes('--video-generation');
  const unsupportedLegacy = args.some(arg => [
    '--batch-prompt-file', '--resume', '--debug-ui', '--debug-images',
    '--debug-video-menu', '--download-last-video', '--dry-run',
  ].includes(arg));
  if (legacyVideo && !unsupportedLegacy) {
    runPython(translateLegacyVideo(args));
    return true;
  }
  return false;
}
