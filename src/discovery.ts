/**
 * IFM model discovery.
 *
 * This module is intentionally free of `@earendil-works/pi-ai` runtime imports
 * so it can be unit tested against mock HTTP fixtures. The provider factory
 * converts the returned plain model descriptors into Pi `Model` objects.
 *
 * Discovery contract:
 *   1. `GET /v1/models` is the authority for which model ids exist.
 *   2. Each candidate that is not an obvious non-chat family is confirmed with
 *      a minimal `/chat/completions` probe.
 *   3. A successful probe means "chat"; `operation_not_supported` and model
 *      validation errors mean "not chat"; transient failures are treated as
 *      "unknown" and are kept optimistically so a temporary outage never drops
 *      a healthy catalog.
 *   4. An empty or failed discovery never replaces a non-empty last-known-good
 *      catalog.
 */

import {
	IFM_CHAT_PATH,
	IFM_DEFAULT_CONTEXT_WINDOW,
	IFM_DEFAULT_MAX_TOKENS,
	IFM_MODEL_INFO,
	IFM_MODELS_PATH,
	IFM_NON_CHAT_PATTERN,
	IFM_PROBE_CACHE_TTL_MS,
	IFM_PROBE_MIN_INTERVAL_MS,
} from "./constants.ts";

/** Thinking levels Pi may request, mapped to what IFM accepts. */
export const IFM_THINKING_LEVEL_MAP: Record<string, string | null> = {
	minimal: "low",
	low: "low",
	// IFM's hosted endpoint currently loops when asked for "medium"
	// reasoning, so Pi's default medium is mapped to "low". Users who want
	// deeper reasoning select "high".
	medium: "low",
	high: "high",
	xhigh: "high",
	max: "high",
	// IFM has no documented "off"; the server default (high) applies.
	off: null,
};

/**
 * Compatibility flags verified against api.ifm.ai:
 *  - `store` is rejected: "store: property 'store' is unsupported".
 *  - the `developer` role is rejected: "Invalid value for 'messages.0.role'".
 *  - assistant turns return a `reasoning` field; reasoning effort is selected
 *    through `chat_template_kwargs.reasoning_effort`.
 *  - tool schemas may carry `strict`.
 */
export const IFM_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
	requiresReasoningContentOnAssistantMessages: true,
} as const;

/** Plain descriptor for one discovered chat model. */
export interface IfmChatModelDescriptor {
	id: string;
	name: string;
	api: "openai-completions";
	provider: string;
	baseUrl: string;
	input: ["text"];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	samplingParams?: { temperature?: number };
	thinkingLevelMap: Record<string, string | null>;
	compat: typeof IFM_COMPAT;
}

export type ChatCapability = "chat" | "non-chat" | "unknown";

export interface IfmRefreshInfo {
	lastAttemptAt?: number;
	lastSuccessAt?: number;
	lastError?: string;
	lastSource: "network" | "cache" | "none";
	lastModelCount: number;
	lastProbeCount: number;
}

export interface IfmDiscoveryContext {
	baseUrl: string;
	apiKey: string;
	providerId: string;
	signal: AbortSignal;
	/** Last-known-good models restored from Pi's persisted catalog, if any. */
	storedModels?: readonly IfmChatModelDescriptor[];
}

export interface IfmDiscoveryOptions {
	fetchImpl?: typeof fetch;
	/** Override capability probing (used by tests). */
	probeChat?: (baseUrl: string, apiKey: string, modelId: string, signal: AbortSignal) => Promise<ChatCapability>;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

function authHeaders(apiKey: string): Record<string, string> {
	return {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Extract model ids from a `/v1/models` response, preserving order. */
export function parseModelList(payload: unknown): string[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("IFM /v1/models returned an unexpected payload (missing 'data' array).");
	}
	const ids: string[] = [];
	for (const item of payload.data) {
		if (isRecord(item) && typeof item.id === "string" && item.id.trim().length > 0) {
			ids.push(item.id);
		}
	}
	return [...new Set(ids)];
}

/** Generic pre-filter for entries that cannot be chat models. */
export function isObviouslyNonChat(modelId: string): boolean {
	return IFM_NON_CHAT_PATTERN.test(modelId);
}

/** Derive a readable display name while preserving the model id verbatim. */
export function deriveDisplayName(modelId: string): string {
	const slash = modelId.indexOf("/");
	return slash >= 0 && slash + 1 < modelId.length ? modelId.slice(slash + 1) : modelId;
}

/** Build a conservative descriptor for a confirmed chat model. */
export function describeModel(modelId: string, providerId: string, baseUrl: string): IfmChatModelDescriptor {
	const info = IFM_MODEL_INFO[modelId] ?? {
		contextWindow: IFM_DEFAULT_CONTEXT_WINDOW,
		maxTokens: IFM_DEFAULT_MAX_TOKENS,
	};
	return {
		id: modelId,
		name: info.name ?? deriveDisplayName(modelId),
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens,
		reasoning: true,
		thinkingLevelMap: IFM_THINKING_LEVEL_MAP,
		samplingParams: { temperature: 0.2 },
		compat: IFM_COMPAT,
	};
}

async function readErrorPayload(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

/**
 * Confirm whether a model id serves chat completions. Never throws for a
 * transient failure; throws only when the credential itself is rejected so the
 * caller can surface an auth error.
 */
export async function probeChatSupport(
	baseUrl: string,
	apiKey: string,
	modelId: string,
	signal: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<ChatCapability> {
	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl}${IFM_CHAT_PATH}`, {
			method: "POST",
			headers: authHeaders(apiKey),
			body: JSON.stringify({
				model: modelId,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
			}),
			signal,
		});
	} catch (error) {
		if (signal.aborted) throw error;
		return "unknown";
	}

	if (response.ok) return "chat";
	if (response.status === 401 || response.status === 403) {
		throw new Error(`IFM rejected the API key while checking "${modelId}" (HTTP ${response.status}).`);
	}

	const payload = await readErrorPayload(response);
	const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
	const code = typeof error?.code === "string" ? error.code : "";
	const param = typeof error?.param === "string" ? error.param : "";
	const message = String(error?.message ?? (isRecord(payload) ? payload.detail : "") ?? "");
	if (code === "operation_not_supported" || code === "not_found_error") return "non-chat";
	if (response.status === 404) return "non-chat";
	if (
		(response.status === 400 || response.status === 422) &&
		(param === "model" || /not configured for the selected model/i.test(message))
	) {
		return "non-chat";
	}
	return "unknown";
}

export interface IfmDiscovery {
	/** Fetch and validate the current IFM chat catalog. Preserves on failure. */
	fetchModels(context: IfmDiscoveryContext): Promise<IfmChatModelDescriptor[]>;
	/** Current discovery diagnostics for `/ifm status`. */
	state(): Readonly<IfmRefreshInfo>;
}

/**
 * Create an independent discovery instance. The provider factory holds one
 * instance so `/ifm status` can read the last refresh result.
 */
export function createIfmDiscovery(options: IfmDiscoveryOptions = {}): IfmDiscovery {
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? (() => Date.now());
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const probeChat =
		options.probeChat ?? ((baseUrl, apiKey, id, signal) => probeChatSupport(baseUrl, apiKey, id, signal, fetchImpl));

	const probeCache = new Map<string, { capability: ChatCapability; at: number }>();
	let lastProbeAt = 0;
	const state: IfmRefreshInfo = {
		lastSource: "none",
		lastModelCount: 0,
		lastProbeCount: 0,
	};

	async function cachedProbe(
		baseUrl: string,
		apiKey: string,
		id: string,
		signal: AbortSignal,
	): Promise<ChatCapability> {
		const cached = probeCache.get(id);
		if (cached && now() - cached.at < IFM_PROBE_CACHE_TTL_MS) return cached.capability;

		const wait = IFM_PROBE_MIN_INTERVAL_MS - (now() - lastProbeAt);
		if (wait > 0) await sleep(wait);
		lastProbeAt = now();

		const capability = await probeChat(baseUrl, apiKey, id, signal);
		probeCache.set(id, { capability, at: now() });
		return capability;
	}

	async function fetchModels(context: IfmDiscoveryContext): Promise<IfmChatModelDescriptor[]> {
		const stored = context.storedModels ?? [];
		state.lastAttemptAt = now();
		state.lastProbeCount = 0;

		try {
			const response = await fetchImpl(`${context.baseUrl}${IFM_MODELS_PATH}`, {
				headers: authHeaders(context.apiKey),
				signal: context.signal,
			});
			if (!response.ok) {
				throw new Error(`IFM /v1/models failed with HTTP ${response.status}.`);
			}
			const ids = parseModelList(await response.json());
			if (ids.length === 0) {
				// A successful but empty catalog must not wipe a healthy one.
				state.lastError = "IFM returned an empty model list; keeping last-known-good catalog.";
				state.lastSource = stored.length > 0 ? "cache" : "none";
				state.lastModelCount = stored.length;
				return [...stored];
			}

			const models: IfmChatModelDescriptor[] = [];
			for (const id of ids) {
				if (context.signal.aborted) throw new Error("aborted");
				if (isObviouslyNonChat(id)) continue;
				state.lastProbeCount += 1;
				const capability = await cachedProbe(context.baseUrl, context.apiKey, id, context.signal);
				if (capability === "non-chat") continue;
				models.push(describeModel(id, context.providerId, context.baseUrl));
			}

			if (models.length === 0) {
				state.lastError = "IFM returned no eligible chat models; keeping last-known-good catalog.";
				state.lastSource = stored.length > 0 ? "cache" : "none";
				state.lastModelCount = stored.length;
				return [...stored];
			}

			state.lastSuccessAt = now();
			state.lastError = undefined;
			state.lastSource = "network";
			state.lastModelCount = models.length;
			return models;
		} catch (error) {
			if (context.signal.aborted) throw error;
			state.lastError = error instanceof Error ? error.message : String(error);
			state.lastSource = stored.length > 0 ? "cache" : "none";
			state.lastModelCount = stored.length;
			// Rethrow so Pi records the refresh error and keeps the restored
			// last-known-good catalog without refreshing its persistence timestamp.
			throw error;
		}
	}

	return { fetchModels, state: () => ({ ...state }) };
}
