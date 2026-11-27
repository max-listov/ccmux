import { defineErrors } from 'stitchkit/contract';

/**
 * Every refusal stitchmux answers with: one code, its HTTP status, whether repeating the call can
 * succeed, and a default sentence a consumer can show. A throw site names the code through
 * `refusals.errors.<CODE>()` and may say more in its own `message`; a consumer reads the same table
 * from `stitchmux/control-client` instead of keeping a dictionary of our codes.
 *
 * One code has one status. Where a word meant two things — `UNAVAILABLE` for a runtime that is down
 * (503) and for a request whose precondition does not hold (409) — the second became its own code.
 */
export const refusals = defineErrors({
  APPLICATION_POLICY_UNAVAILABLE: {
    status: 409,
    retryable: false,
    message: 'The application authority this session runs under is unavailable',
  },
  ARCHIVED: { status: 409, retryable: false, message: 'The session is archived' },
  ATTACHMENT_UNAVAILABLE: {
    status: 409,
    retryable: false,
    message: 'The attachment is unavailable',
  },
  BUSY: { status: 429, retryable: true, message: 'The daemon is at capacity; try again shortly' },
  CANCELLED: { status: 499, retryable: true, message: 'The operation was cancelled' },
  CAPACITY: { status: 429, retryable: true, message: 'Capacity is exhausted; try again shortly' },
  CHAT_DISABLED: { status: 409, retryable: false, message: 'Chat is disabled for this session' },
  COLLABORATION_MODE_UNAVAILABLE: {
    status: 409,
    retryable: false,
    message: 'The requested collaboration mode is unavailable',
  },
  COMMUNICATION_AUTHORIZATION_REQUIRED: {
    status: 403,
    retryable: false,
    message: 'This message needs a communication authorization',
  },
  COMMUNICATION_AUTHORIZATION_UNVERIFIED: {
    status: 403,
    retryable: false,
    message: 'The communication authorization could not be verified',
  },
  CONFIG_CHANGED: {
    status: 503,
    retryable: true,
    message: 'The machine configuration changed; retry the read',
  },
  CONTEXT_BUSY: { status: 409, retryable: true, message: 'Another context operation is running' },
  CONTEXT_CAPACITY: {
    status: 409,
    retryable: false,
    message: 'The context operation journal is full',
  },
  CONTEXT_CONFLICT: {
    status: 409,
    retryable: false,
    message: 'The context operation conflicts with another',
  },
  CONTEXT_RPC_PENDING: {
    status: 409,
    retryable: true,
    message: 'A context request to the provider is still pending',
  },
  CONTEXT_UNAVAILABLE: {
    status: 503,
    retryable: true,
    message: 'Context operations are unavailable',
  },
  CORRUPT_STATE: { status: 503, retryable: true, message: 'Stored state is unreadable' },
  CREATE_CAPACITY: {
    status: 409,
    retryable: false,
    message: 'No more sessions can be created now',
  },
  CREATE_FAILED: { status: 409, retryable: false, message: 'The session could not be created' },
  CREATE_PENDING: { status: 503, retryable: true, message: 'The session is still being created' },
  CURSOR_MISMATCH: { status: 409, retryable: false, message: 'The cursor belongs to another read' },
  DELEGATION_REFUSED: {
    status: 409,
    retryable: false,
    message: 'The delegation does not allow this',
  },
  DIRECTORY_TOO_LARGE: {
    status: 413,
    retryable: false,
    message: 'The directory has too many entries to list',
  },
  FORBIDDEN: { status: 403, retryable: false, message: 'This caller may not do that' },
  FORK_BUSY: { status: 409, retryable: true, message: 'A fork of this session is in progress' },
  FORK_PENDING: { status: 503, retryable: true, message: 'The fork has not settled yet' },
  FORK_UNAVAILABLE: { status: 409, retryable: false, message: 'This session cannot be forked' },
  FORK_UNCERTAIN: {
    status: 409,
    retryable: false,
    message: 'Whether the fork happened is unknown',
  },
  HISTORY_CURSOR: {
    status: 409,
    retryable: false,
    message: 'The history cursor is no longer valid',
  },
  HISTORY_UNAVAILABLE: {
    status: 503,
    retryable: true,
    message: 'The conversation history is unavailable',
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    retryable: false,
    message: 'The same operation ID was used with a different request',
  },
  IDENTITY_MISMATCH: {
    status: 409,
    retryable: false,
    message: 'The exact session identity does not match',
  },
  INVALID_CURSOR: { status: 400, retryable: false, message: 'The cursor is invalid' },
  INVALID_INPUT: { status: 400, retryable: false, message: 'The input is invalid' },
  INVALID_OPTION: { status: 400, retryable: false, message: 'The option is invalid' },
  INVALID_RECIPE_CREATE: {
    status: 409,
    retryable: false,
    message: 'The launch recipe cannot create this session',
  },
  INVALID_TARGET: { status: 400, retryable: false, message: 'The target is invalid' },
  INVALID_WORKSPACE: { status: 400, retryable: false, message: 'The workspace is invalid' },
  JOURNAL_CAPACITY: { status: 409, retryable: false, message: 'The selection journal is full' },
  LAGGED: {
    status: 409,
    retryable: false,
    message: 'The reader fell behind the feed; resume from its last cursor',
  },
  LAUNCH_RECIPE_UNAVAILABLE: {
    status: 409,
    retryable: false,
    message: 'The launch recipe is unavailable',
  },
  LETTER_REFUSED: { status: 409, retryable: false, message: 'The letter was refused' },
  MESSAGE_EVIDENCE_UNAVAILABLE: {
    status: 503,
    retryable: true,
    message: 'The message evidence is unavailable',
  },
  MENU_OPEN: { status: 409, retryable: false, message: 'The session is at a selection menu' },
  MIN_AWAKE_PER_PROFILE: {
    status: 409,
    retryable: false,
    message: 'The profile must keep its minimum number of awake sessions',
  },
  MODEL_UNAVAILABLE: {
    status: 409,
    retryable: false,
    message: 'The model is not in this host’s catalog',
  },
  NO_INFERENCE_CREATE_REQUIREMENTS: {
    status: 409,
    retryable: false,
    message: 'A create without inference needs an explicit model and runtime',
  },
  NO_INFERENCE_CREATE_UNSUPPORTED: {
    status: 409,
    retryable: false,
    message: 'This runtime cannot guarantee a create without inference',
  },
  NOT_A_DIRECTORY: { status: 400, retryable: false, message: 'The path is not a directory' },
  NOT_FOUND: { status: 404, retryable: false, message: 'No such session or item' },
  NOT_IDLE: { status: 409, retryable: false, message: 'The session is busy' },
  NOT_RUNNING: { status: 409, retryable: false, message: 'The session is not running' },
  NOT_SLEEPING: { status: 409, retryable: false, message: 'The session is not sleeping' },
  ORIGIN_REFUSED: {
    status: 403,
    retryable: false,
    message: 'The request origin is not allowed here',
  },
  PERMISSION_DENIED: { status: 403, retryable: false, message: 'Permission denied' },
  PERMISSION_MODE_UNAVAILABLE: {
    status: 409,
    retryable: false,
    message: 'The permission mode is unavailable',
  },
  PINNED_SESSION: { status: 409, retryable: false, message: 'The session is pinned awake' },
  PRECONDITION_FAILED: {
    status: 409,
    retryable: false,
    message: 'The request cannot run in the session’s or host’s current state',
  },
  PROFILE_UNAVAILABLE: {
    status: 409,
    retryable: false,
    message: 'The account profile is unavailable',
  },
  PROMPT_UNCONFIRMED: {
    status: 409,
    retryable: false,
    message: 'The prompt was not confirmed by the session',
  },
  REGISTRATION_UNAVAILABLE: {
    status: 409,
    retryable: false,
    message: 'The session has no registration generation',
  },
  RESOURCE_EXHAUSTED: {
    status: 429,
    retryable: true,
    message: 'A bounded resource is exhausted; try again',
  },
  REVISION_CONFLICT: {
    status: 409,
    retryable: false,
    message: 'The state changed since it was read',
  },
  ROLLBACK_UNSUPPORTED: { status: 409, retryable: false, message: 'This session cannot roll back' },
  SELECTION_UNAVAILABLE: {
    status: 409,
    retryable: false,
    message: 'The model selection is unavailable',
  },
  SESSION_BLOCKED: {
    status: 409,
    retryable: false,
    message: 'The session is blocked until it is repaired',
  },
  SESSION_SLEEPING: {
    status: 409,
    retryable: false,
    message: 'The session is sleeping; wake it first',
  },
  SLEEP_PENDING: { status: 409, retryable: true, message: 'A sleep operation is pending' },
  SLEEP_SUPERSEDED: {
    status: 409,
    retryable: false,
    message: 'The sleep was followed by another lifecycle operation',
  },
  STALE_CURSOR: { status: 409, retryable: false, message: 'The cursor needs a fresh baseline' },
  STEERING_UNAVAILABLE: {
    status: 503,
    retryable: true,
    message: 'Steering the running turn is unavailable',
  },
  STALE_PROMPT: {
    status: 409,
    retryable: false,
    message: 'The prompt is no longer the current one',
  },
  STALE_REQUEST: {
    status: 409,
    retryable: false,
    message: 'The request refers to a state that has moved on',
  },
  SYMLINK_REFUSED: { status: 409, retryable: false, message: 'Symbolic links are refused here' },
  TIMEOUT: { status: 504, retryable: true, message: 'The operation did not finish in time' },
  TOO_LARGE: { status: 413, retryable: false, message: 'The content exceeds its byte budget' },
  TURN_MISMATCH: { status: 409, retryable: false, message: 'The turn is not the current one' },
  UNAUTHORIZED: { status: 401, retryable: false, message: 'The caller is not authenticated' },
  UNAVAILABLE: { status: 503, retryable: true, message: 'The runtime or service is unavailable' },
  UNSUPPORTED: {
    status: 409,
    retryable: false,
    message: 'This session or runtime does not support that',
  },
  VALIDATION_ERROR: { status: 400, retryable: false, message: 'The request failed validation' },
  WAKE_CAPACITY: { status: 409, retryable: false, message: 'The wake journal is full' },
  WAKE_FAILED: { status: 409, retryable: false, message: 'The session could not be woken' },
  WAKE_PENDING: { status: 409, retryable: true, message: 'A wake is pending' },
});

/** A code from the refusal table. */
export type RefusalCode = keyof typeof refusals.codes;
