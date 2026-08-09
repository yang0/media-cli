/**
 * Public module surface for programmatic use.
 * CLI entry remains ./cli.js
 */
export { main } from "./main.js";
export { parseArgs, usage } from "./args.js";
export { DolaCliError } from "./errors.js";
export * from "./config.js";
export { loadAccountPool, listAccountPoolStatus, chooseAccount, loadPoolDayState } from "./accounts/pool.js";
export { installVideoRequestPatch } from "./video/patch.js";
export { installVideoResolveHelpers, collectDomVideos } from "./video/resolve.js";
