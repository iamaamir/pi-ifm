import { describe, expect, test } from "bun:test";
import { IFM_DEFAULT_BASE_URL, IFM_PROVIDER_ID } from "../src/constants.ts";
import type { IfmChatModelDescriptor, IfmDiscovery } from "../src/discovery.ts";
import { createIfmProvider, toIfmModel } from "../src/provider.ts";

const descriptor: IfmChatModelDescriptor = {
	id: "IFM/K2-Horizon-375B-A23B",
	name: "K2-Horizon-375B-A23B",
	api: "openai-completions",
	provider: IFM_PROVIDER_ID,
	baseUrl: IFM_DEFAULT_BASE_URL,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131_072,
	maxTokens: 32_768,
	reasoning: true,
	thinkingLevelMap: { high: "high" },
	compat: {} as IfmChatModelDescriptor["compat"],
};

function fakeDiscovery(models: IfmChatModelDescriptor[]): IfmDiscovery {
	return {
		fetchModels: async () => models,
		state: () => ({
			lastSource: "network",
			lastModelCount: models.length,
			lastProbeCount: models.length,
		}),
	};
}

describe("createIfmProvider", () => {
	test("registers identity and api-key auth", () => {
		const provider = createIfmProvider({ discovery: fakeDiscovery([]) });
		expect(provider.id).toBe(IFM_PROVIDER_ID);
		expect(provider.name).toBe("IFM");
		expect(provider.baseUrl).toBe(IFM_DEFAULT_BASE_URL);
		expect(provider.auth.apiKey).toBeDefined();
		expect(provider.getModels()).toEqual([]);
	});

	test("native login collects and returns an api-key credential", async () => {
		const provider = createIfmProvider({ discovery: fakeDiscovery([]) });
		const apiKey = provider.auth.apiKey!;
		expect(typeof apiKey.login).toBe("function");
		let promptType = "";
		const credential = await apiKey.login?.({
			signal: new AbortController().signal,
			prompt: async (prompt) => {
				promptType = prompt.type;
				return "IFM-test-key";
			},
			notify: () => {},
		});
		expect(promptType).toBe("secret");
		expect(credential).toEqual({ type: "api_key", key: "IFM-test-key" });
	});

	test("resolves the key from the environment", async () => {
		const provider = createIfmProvider({ discovery: fakeDiscovery([]) });
		const result = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "IFM_API_KEY" ? "env-key" : undefined), fileExists: async () => false },
			signal: new AbortController().signal,
		});
		expect(result?.auth.apiKey).toBe("env-key");
		expect(result?.source).toBe("IFM_API_KEY");
	});

	test("resolves the token from the environment", async () => {
		const provider = createIfmProvider({ discovery: fakeDiscovery([]) });
		const result = await provider.auth.apiKey?.resolve({
			ctx: { env: async (name) => (name === "IFM_API_TOKEN" ? "token-key" : undefined), fileExists: async () => false },
			signal: new AbortController().signal,
		});
		expect(result?.auth.apiKey).toBe("token-key");
		expect(result?.source).toBe("IFM_API_TOKEN");
	});

	test("publishes discovered models", async () => {
		const provider = createIfmProvider({ discovery: fakeDiscovery([descriptor]) });
		const publishCalls: unknown[] = [];
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			allowNetwork: true,
			signal: new AbortController().signal,
			baseUrl: IFM_DEFAULT_BASE_URL,
			publish: async (publication) => {
				publishCalls.push(publication);
				publication.update?.();
				return true;
			},
		});
		expect(provider.getModels().map((model) => model.id)).toEqual([descriptor.id]);
		expect(publishCalls.length).toBe(1);
	});

	test("keeps restored models when the credential is absent", async () => {
		const provider = createIfmProvider({ discovery: fakeDiscovery([descriptor]) });
		let updateCalled = false;
		await provider.refreshModels?.({
			credential: undefined,
			allowNetwork: true,
			signal: new AbortController().signal,
			baseUrl: IFM_DEFAULT_BASE_URL,
			publish: async (publication) => {
				publication.update?.();
				updateCalled = true;
				return true;
			},
		});
		// With no stored models and no credential, fetchModels returns [].
		expect(provider.getModels()).toEqual([]);
		expect(updateCalled).toBe(true);
	});
});

describe("toIfmModel", () => {
	test("copies descriptor fields", () => {
		const model = toIfmModel(descriptor);
		expect(model.id).toBe(descriptor.id);
		expect(model.api).toBe("openai-completions");
		expect(model.input).toEqual(["text"]);
	});
});
