/**
 * IFM provider factory.
 *
 * Builds a native Pi `Provider` that delegates streaming to Pi's OpenAI
 * Completions adapter and owns dynamic model discovery. Streaming, tool-call
 * parsing, usage accounting, cancellation, and retries stay in Pi; this module
 * only supplies IFM-specific auth, discovery, and compatibility metadata.
 */

import {
	createProvider,
	envApiKeyAuth,
	type Model,
	openAICompletionsApi,
	type Provider,
} from "@earendil-works/pi-ai/compat";
import {
	IFM_API_KEY_ENV,
	IFM_API_TOKEN_ENV,
	IFM_DEFAULT_BASE_URL,
	IFM_PROVIDER_ID,
	IFM_PROVIDER_NAME,
} from "./constants.ts";
import { createIfmDiscovery, IFM_COMPAT, type IfmChatModelDescriptor, type IfmDiscovery } from "./discovery.ts";

export interface CreateIfmProviderOptions {
	/** Share a discovery instance with the extension so `/ifm status` sees refresh state. */
	discovery?: IfmDiscovery;
	baseUrl?: string;
}

function stripTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

/** Convert a plain descriptor into a Pi chat model. */
export function toIfmModel(descriptor: IfmChatModelDescriptor): Model<"openai-completions"> {
	return {
		...descriptor,
		// Keep IFM's wire contract current even for catalogs restored from an
		// older persisted version: a missing thinking flag breaks multi-turn.
		compat: { ...IFM_COMPAT, ...descriptor.compat, requiresReasoningContentOnAssistantMessages: true },
	} as Model<"openai-completions">;
}

/**
 * Create the native IFM provider. The provider starts with no static models and
 * fills its catalog from `GET /v1/models` through `fetchModels`, which Pi
 * persists transactionally and restores offline.
 */
export function createIfmProvider(options: CreateIfmProviderOptions = {}): Provider<"openai-completions"> {
	const discovery = options.discovery ?? createIfmDiscovery();
	const defaultBaseUrl = options.baseUrl ?? IFM_DEFAULT_BASE_URL;

	return createProvider<"openai-completions">({
		id: IFM_PROVIDER_ID,
		name: IFM_PROVIDER_NAME,
		baseUrl: defaultBaseUrl,
		auth: {
			apiKey: (() => {
				const auth = envApiKeyAuth("IFM API key", [IFM_API_TOKEN_ENV, IFM_API_KEY_ENV]);
				auth.login = async (interaction) => {
					interaction.signal.throwIfAborted();
					const key = await interaction.prompt({ type: "secret", message: "Enter IFM API key" });
					interaction.signal.throwIfAborted();
					return { type: "api_key", key: key.trim() };
				};
				return auth;
			})(),
		},
		models: [],
		api: openAICompletionsApi(),
		fetchModels: async (context) => {
			const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			const storedModels = (context.stored?.models ?? [])
				.filter((model) => model.provider === IFM_PROVIDER_ID)
				.map((model) => ({
					...(model as unknown as IfmChatModelDescriptor),
					baseUrl: context.baseUrl ?? (model as unknown as IfmChatModelDescriptor).baseUrl,
				}));

			// No credential: keep whatever Pi already restored.
			if (!apiKey) return storedModels.map(toIfmModel);

			const baseUrl = stripTrailingSlash(context.baseUrl ?? defaultBaseUrl);
			const models = await discovery.fetchModels({
				baseUrl,
				apiKey,
				providerId: IFM_PROVIDER_ID,
				signal: context.signal,
				storedModels,
			});
			return models.map(toIfmModel);
		},
	});
}
