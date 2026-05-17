/** Maximum events kept in the transcript ring buffer. */
export const MAX_TRANSCRIPT_EVENTS = 500;

/** Magic string IDs for DOM-like OpenTUI nodes. */
export const ROOT_ID = 'synax-root';
export const ARTIFACTS_ID = 'synax-artifacts';
export const INPUT_ID = 'synax-input';
export const FOOTER_ID = 'synax-footer';
export const STATUS_ID = 'synax-status';
export const HINTS_ID = 'synax-hints';
export const LOCATION_ID = 'synax-location';
export const EMPTY_STATE_ID = 'synax-empty-state';
export const AUTOCOMPLETE_ID = 'synax-autocomplete';
export const RIGHT_RAIL_ID = 'synax-right-rail';
export const RAIL_FILES_ID = 'synax-rail-files';
export const RAIL_CONTEXT_ID = 'synax-rail-context';
export const RAIL_COST_ID = 'synax-rail-cost';
export const RAIL_UPTIME_ID = 'synax-rail-uptime';
export const RAIL_MODEL_ID = 'synax-rail-model';
export const RAIL_BRANCH_ID = 'synax-rail-branch';
export const PERSISTENT_STATUS_CARD_ID = 'persistent-status-card';
export const SCROLL_INDICATOR_ID = 'synax-scroll-indicator';
export const ACTIVITY_LINE_ID = 'synax-activity-line';
export const ACTIVITY_GLYPH_ID = 'synax-activity-glyph';
export const ACTIVITY_TEXT_ID = 'synax-activity-text';

/** Max autocomplete rows shown in the dropdown overlay. */
export const AUTOCOMPLETE_MAX_ROWS = 10;

/** Hunk/command output slice limits. */
export const HUNK_PREVIEW_LINES = 12;
export const HUNK_SCROLLBOX_THRESHOLD = 50;
export const STDOUT_PREVIEW_LINES = 50;
export const STDOUT_FULL_LINES = 200;
export const STDERR_PREVIEW_LINES = 20;
export const STDERR_FULL_LINES = 200;
export const TOOL_RESULT_OUTPUT_LINES = 80;
export const TEXT_PREVIEW_LINES = 8;
export const OUTPUT_SHOW_ALL_THRESHOLD = 70;

/** Right rail constraints. */
export const RIGHT_RAIL_MIN_WIDTH = 100;
export const RIGHT_RAIL_WIDTH = 24;
export const RAIL_MAX_FILES = 5;
export const RAIL_MAX_CHECKPOINTS = 3;

/** Checkpoint auto-emit interval (every N files changed). */
export const CHECKPOINT_FILE_INTERVAL = 5;

/** Plan card max steps shown. */
export const PLAN_MAX_STEPS = 5;

/** Context chip display. */
export const CONTEXT_CHIPS_MAX = 4;

/** Splash animation frame interval (ms). */
export const SPLASH_FRAME_MS = 500;

/** Line length clipping defaults. */
export const CLIP_DEFAULT_WIDTH = 160;
export const CLIP_SINGLE_LINE_WIDTH = 160;
export const MODEL_RAIL_CLIP = 22;
export const STEERING_BUFFER_CLIP = 40;
export const STATUS_DETAIL_CLIP = 47;

/** Footer layout constants. */
export const FOOTER_BASE_HEIGHT = 3;

/** Slash command autocomplete query matching. */
export const CTRL_C_QUIT_TIMEOUT_MS = 800;

/** Scroll amount (rows) for up/down keys. */
export const SCROLL_STEP_ROWS = 9;
/** Scroll amount (proportion of terminal height) for page up/down. */
export const SCROLL_PAGE_FACTOR = 0.7;

/** Event types that update state but should NOT create visible transcript cards. */
export const TRANSIENT_EVENT_TYPES = new Set(['command_output' as const, 'model_step_started' as const]);
