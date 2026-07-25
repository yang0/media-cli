#!/usr/bin/env node
import { main } from './main.js';
import { handleJobCommand } from './job-command.js';

try {
  if (!handleJobCommand(process.argv)) {
    main().catch(error => {
      const code = error.code || 'DOLA_CLI_ERROR';
      const details = error.details ? `\n${JSON.stringify(error.details, null, 2)}` : '';
      console.error(`[dola-cli] failed (${code}): ${error.stack || error.message}${details}`);
      process.exit(1);
    });
  }
} catch (error) {
  console.error(`[dola-cli] failed (DOLA_JOB_CLI_ERROR): ${error.stack || error.message}`);
  process.exit(1);
}
