export const DEFAULT_CDP = "http://127.0.0.1:9221";

export const DEFAULT_SESSION = "https://www.dola.com/chat/38415631468262161";

export const DOLA_CHAT_HOME = "https://www.dola.com/chat";

/** @deprecated Prefer /chat + skill chip; create-image gallery burns bandwidth. Kept for compat only. */
export const DOLA_IMAGE_HOME = "https://www.dola.com/chat";

export const DEFAULT_OUT_DIR = "downloads";

export const DEFAULT_SESSION_STATE = ".dola-cli-session.json";

// Account rotation is the default execution mode. Override this path with
// DOLA_ACCOUNT_POOL or the --account-pool CLI option when needed.
export const DEFAULT_ACCOUNT_POOL = process.env.DOLA_ACCOUNT_POOL || "G:\\cookies\\dola";
/** Official UI only exposes 5s/10s; 15s works via /chat/completion body patch + Seedance v2. */

export const DEFAULT_VIDEO_DURATION = "5";

export const VIDEO_MODEL_SEEDANCE_V2 = "seedance_v2.0";

export const VIDEO_ABILITY_TYPE = 17;

export const DOLA_MEDIA_AID = "489823";
