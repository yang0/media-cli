import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_CDP = process.env.X_CDP_URL || "http://127.0.0.1:9221";
export const DRAFTS_DIR = path.resolve(__dirname, "../../drafts");
export const DRAFTS_FILE = path.join(DRAFTS_DIR, "reply_drafts.json");
export const HISTORY_FILE = path.join(DRAFTS_DIR, "sent_history.json");
