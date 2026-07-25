#!/usr/bin/env node
import { main } from './main.js';

main().catch(error => {
  const code = error.code || 'DOLA_CLI_ERROR';
  const details = error.details ? `\n${JSON.stringify(error.details, null, 2)}` : '';
  console.error(`[dola-cli] failed (${code}): ${error.stack || error.message}${details}`);
  process.exit(1);
});
