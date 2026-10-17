/**
 * Shared IFM provider constants.
 *
 * Everything here is provider-wide, not model-specific. IFM's public model list
 * (`GET /v1/models`) returns only `id`, `object`, `created`, and `owned_by`, so
 * there is no per-model metadata to hardcode. Conservative defaults are used
 * for every discovered chat model and can be overridden per model through
 * `models.json` if an account needs different limits.
 */

export const IFM_PROVIDER_ID = "ifm";
export const IFM_PROVIDER_NAME = "IFM";
export const IFM_DEFAULT_BASE_URL = "https://api.ifm.ai/v1";
export const IFM_API_KEY_ENV = "IFM_API_KEY";

/** Path (relative to the base URL) used for live model discovery. */
export const IFM_MODELS_PATH = "/models";
/** Path (relative to the base URL) used for chat completions. */
export const IFM_CHAT_PATH = "/chat/completions";

/**
 * Conservative default context window. The hosted K2 Horizon family advertises
 * 512K, but `GET /v1/models` does not publish context size, so under- rather
 * than over-estimate to keep Pi's compaction safe.
 */
export const IFM_DEFAULT_CONTEXT_WINDOW = 131_072;
/** Conservative default maximum output tokens. */
export const IFM_DEFAULT_MAX_TOKENS = 32_768;

/** Cache lifetime for capability probes within one process. */
export const IFM_PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
/** Minimum spacing between capability probes to respect IFM's short-window request guard. */
export const IFM_PROBE_MIN_INTERVAL_MS = 350;

/**
 * Generic, model-agnostic filter for entries that are not chat models.
 * IFM exposes speech and other non-chat endpoints through the same list; these
 * naming families are never chat completions. This is a pre-filter only —
 * anything that survives is still checked against `/chat/completions`.
 */
export const IFM_NON_CHAT_PATTERN =
	/(^|[/_\-. ])(asr|stt|tts|whisper|audio|speech|voice|transcrib\w*|embed\w*|rerank\w*|moderation)([/_\-. ]|$)/i;
