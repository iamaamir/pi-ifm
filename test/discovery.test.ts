import { describe, expect, test } from "bun:test";
import {
	createIfmDiscovery,
	describeModel,
	deriveDisplayName,
	IFM_THINKING_LEVEL_MAP,
	isObviouslyNonChat,
	parseModelList,
	type IfmChatModelDescriptor,
} from "../src/discovery.ts";

const BASE_URL = "https://api.ifm.ai/v1";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function modelsResponse(ids: string[]): Response {
	return jsonResponse({ object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "MBZUAI" })) });
}

function signal(): AbortSignal {
	return new AbortController().signal;
}

describe("parseModelList", () => {
	test("extracts ids and drops duplicates", () => {
		expect(parseModelList({ data: [{ id: "a" }, { id: "b" }, { id: "a" }] })).toEqual(["a", "b"]);
	});

	test("rejects malformed payloads", () => {
		expect(() => parseModelList({ object: "list" })).toThrow(/unexpected payload/);
		expect(() => parseModelList(null)).toThrow(/unexpected payload/);
	});
});

describe("model id helpers", () => {
	test("detects non-chat families", () => {
		expect(isObviouslyNonChat("IFM/Jais-ASR")).toBe(true);
		expect(isObviouslyNonChat("IFM/whisper-large")).toBe(true);
		expect(isObviouslyNonChat("IFM/text-embedding-3")).toBe(true);
		expect(isObviouslyNonChat("IFM/K2-Horizon-375B-A23B")).toBe(false);
		expect(isObviouslyNonChat("IFM/Jais-3-MoVA-36B-A4B")).toBe(false);
	});

	test("derives display names without altering the id", () => {
		expect(deriveDisplayName("IFM/K2-Horizon-375B-A23B")).toBe("K2-Horizon-375B-A23B");
		expect(deriveDisplayName("bare-model")).toBe("bare-model");
	});

	test("maps Pi thinking levels onto safe IFM efforts", () => {
		expect(IFM_THINKING_LEVEL_MAP.medium).toBe("low");
		expect(IFM_THINKING_LEVEL_MAP.high).toBe("high");
		expect(IFM_THINKING_LEVEL_MAP.off).toBeNull();
	});
});

describe("describeModel", () => {
	test("uses IFM model metadata for known models", () => {
		const model = describeModel("IFM/K2-Horizon-375B-A23B", "ifm", "https://api.ifm.ai/v1");
		expect(model.contextWindow).toBe(524288);
		expect(model.samplingParams).toEqual({ temperature: 0.2 });
	});
});

describe("createIfmDiscovery", () => {
	test("discovers chat models, probing only plausible candidates", async () => {
		const probed: string[] = [];
		const discovery = createIfmDiscovery({
			fetchImpl: async () => modelsResponse(["IFM/K2-Horizon-375B-A23B", "IFM/Jais-ASR", "IFM/Jais-3-MoVA-36B-A4B"]),
			probeChat: async (_baseUrl, _apiKey, id) => {
				probed.push(id);
				return "chat";
			},
			sleep: async () => {},
		});

		const models = await discovery.fetchModels({
			baseUrl: BASE_URL,
			apiKey: "test-key",
			providerId: "ifm",
			signal: signal(),
		});

		expect(probed).toEqual(["IFM/K2-Horizon-375B-A23B", "IFM/Jais-3-MoVA-36B-A4B"]);
		expect(models.map((model) => model.id)).toEqual(["IFM/K2-Horizon-375B-A23B", "IFM/Jais-3-MoVA-36B-A4B"]);
		expect(models[0]!.provider).toBe("ifm");
		expect(models[0]!.compat.supportsStore).toBe(false);
		expect(discovery.state().lastSource).toBe("network");
	});

	test("excludes models the probe reports as non-chat", async () => {
		const discovery = createIfmDiscovery({
			fetchImpl: async () => modelsResponse(["IFM/chat", "IFM/dedicated"]),
			probeChat: async (_baseUrl, _apiKey, id) => (id === "IFM/chat" ? "chat" : "non-chat"),
			sleep: async () => {},
		});
		const models = await discovery.fetchModels({
			baseUrl: BASE_URL,
			apiKey: "k",
			providerId: "ifm",
			signal: signal(),
		});
		expect(models.map((model) => model.id)).toEqual(["IFM/chat"]);
	});

	test("keeps models when a probe fails transiently", async () => {
		const discovery = createIfmDiscovery({
			fetchImpl: async () => modelsResponse(["IFM/chat"]),
			probeChat: async () => "unknown",
			sleep: async () => {},
		});
		const models = await discovery.fetchModels({
			baseUrl: BASE_URL,
			apiKey: "k",
			providerId: "ifm",
			signal: signal(),
		});
		expect(models.map((model) => model.id)).toEqual(["IFM/chat"]);
	});

	test("returns the last-known-good catalog when the server returns an empty list", async () => {
		const stored: IfmChatModelDescriptor[] = [
			{
				id: "IFM/known",
				name: "known",
				api: "openai-completions",
				provider: "ifm",
				baseUrl: BASE_URL,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 32768,
				reasoning: true,
				thinkingLevelMap: {},
				compat: {} as IfmChatModelDescriptor["compat"],
			},
		];
		const discovery = createIfmDiscovery({
			fetchImpl: async () => modelsResponse([]),
			sleep: async () => {},
		});
		const models = await discovery.fetchModels({
			baseUrl: BASE_URL,
			apiKey: "k",
			providerId: "ifm",
			signal: signal(),
			storedModels: stored,
		});
		expect(models.map((model) => model.id)).toEqual(["IFM/known"]);
		expect(discovery.state().lastError).toMatch(/empty model list/);
	});

	test("throws on a failed list request so Pi keeps the restored catalog", async () => {
		const discovery = createIfmDiscovery({
			fetchImpl: async () => jsonResponse({ error: { message: "boom" } }, 500),
			sleep: async () => {},
		});
		await expect(
			discovery.fetchModels({ baseUrl: BASE_URL, apiKey: "k", providerId: "ifm", signal: signal() }),
		).rejects.toThrow(/HTTP 500/);
		expect(discovery.state().lastError).toMatch(/HTTP 500/);
	});

	test("propagates credential rejection", async () => {
		const discovery = createIfmDiscovery({
			fetchImpl: async () => modelsResponse(["IFM/chat"]),
			probeChat: async () => {
				throw new Error("IFM rejected the API key");
			},
			sleep: async () => {},
		});
		await expect(
			discovery.fetchModels({ baseUrl: BASE_URL, apiKey: "bad", providerId: "ifm", signal: signal() }),
		).rejects.toThrow(/rejected/);
	});
});

describe("probeChatSupport via HTTP", () => {
	test("classifies operation_not_supported as non-chat", async () => {
		const discovery = createIfmDiscovery({
			fetchImpl: async (input) => {
				const url = String(input);
				if (url.endsWith("/models")) return modelsResponse(["IFM/audio"]);
				return jsonResponse(
					{ error: { message: "not configured", code: "operation_not_supported", param: "model" } },
					400,
				);
			},
			sleep: async () => {},
		});
		const models = await discovery.fetchModels({
			baseUrl: BASE_URL,
			apiKey: "k",
			providerId: "ifm",
			signal: signal(),
		});
		expect(models).toEqual([]);
		expect(discovery.state().lastError).toMatch(/no eligible chat models/);
	});
});
