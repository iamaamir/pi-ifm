import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ifmExtension from "../src/extension.ts";
import { makeIfmCleaner } from "../src/extension.ts";
import { IFM_PROVIDER_ID } from "../src/constants.ts";

type Handler = (event: any, ctx: any) => unknown;

function createFakePi() {
	const providers: any[] = [];
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const pi = {
		registerProvider: (provider: any) => providers.push(provider),
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string, options: any) => commands.set(name, options),
	};
	return { pi: pi as unknown as ExtensionAPI, providers, handlers, commands };
}

function context(overrides: Record<string, unknown> = {}) {
	const notifications: { message: string; type?: string }[] = [];
	const ctx = {
		model: { provider: IFM_PROVIDER_ID },
		scopedModels: [],
		modelRegistry: {
			getAll: () => [],
			getProviderAuthStatus: () => ({ configured: true, label: "IFM_API_KEY" }),
			getError: () => undefined,
			refresh: async () => ({ aborted: false, errors: new Map() }),
		},
		ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
		...overrides,
	};
	return { ctx, notifications };
}

describe("ifm extension", () => {
	test("registers the ifm provider and commands", () => {
		const { pi, providers, commands } = createFakePi();
		ifmExtension(pi);
		expect(providers.map((provider) => provider.id)).toEqual([IFM_PROVIDER_ID]);
		expect([...commands.keys()]).toEqual(["ifm"]);
	});

	test("normalizes payloads only for the ifm provider", () => {
		const { pi, handlers } = createFakePi();
		ifmExtension(pi);
		const handler = handlers.get("before_provider_request")![0]!;
		const payload = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
		const normalized = handler({ payload }, context().ctx) as typeof payload;
		expect(normalized.messages[0]!.content).toBe("hi");
		expect(handler({ payload }, context({ model: { provider: "other" } }).ctx)).toBeUndefined();
	});

	test("adds a session id header for IFM", () => {
		const { pi, handlers } = createFakePi();
		ifmExtension(pi);
		const handler = handlers.get("before_provider_headers")![0]!;
		const { ctx } = context({
			sessionManager: { getSessionId: () => "session-123" },
		});
		const event = { headers: {} as Record<string, string> };
		handler(event, ctx);
		expect(event.headers["X-Session-ID"]).toBe("session-123");
	});

	test("normalizes context overflow errors", () => {
		const { pi, handlers } = createFakePi();
		ifmExtension(pi);
		const handler = handlers.get("message_end")![0]!;
		const { ctx } = context();
		const message = {
			role: "assistant",
			stopReason: "error",
			provider: IFM_PROVIDER_ID,
			errorMessage: "request_too_large: prompt exceeds context",
		};
		const result = handler({ message }, ctx) as { message: { errorMessage: string } };
		expect(result.message.errorMessage).toContain("context_length_exceeded");
	});

	test("repairs leaked reasoning in one chunk", async () => {
		const stream = makeIfmCleaner();
		const writer = stream.writable.getWriter();
		const reader = stream.readable.getReader();
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		const writing = (async () => {
			await writer.write(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"thinking</ifm|think>answer"}}]}\n'));
			await writer.close();
		})();
		let output = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			output += decoder.decode(value, { stream: true });
		}
		await writing;
		expect(output).toContain("reasoning_content");
		expect(output).toContain("answer");
		expect(output).toContain("\n\n");
	});

	test("repairs leaked reasoning across segmented chunks", async () => {
		const stream = makeIfmCleaner();
		const writer = stream.writable.getWriter();
		const reader = stream.readable.getReader();
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		const writing = (async () => {
			await writer.write(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"thinking</ifm|thi'));
			await writer.write(encoder.encode('nk>answer"}}]}\n'));
			await writer.close();
		})();
		let output = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			output += decoder.decode(value, { stream: true });
		}
		await writing;
		expect(output).toContain("reasoning_content");
		expect(output).toContain("answer");
	});

	test("warns when a response names a different upstream model", () => {
		const { pi, handlers } = createFakePi();
		ifmExtension(pi);
		const handler = handlers.get("provider_stream_event")![0]!;
		const { ctx, notifications } = context();
		handler({ provider: IFM_PROVIDER_ID, model: "IFM/requested", data: { model: "IFM/actual" } }, ctx);
		handler({ provider: IFM_PROVIDER_ID, model: "IFM/requested", data: { model: "IFM/actual" } }, ctx);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]!.type).toBe("warning");
		expect(notifications[0]!.message).toContain("IFM/actual");
	});

	test("explains a model scope that hides IFM models", () => {
		const { pi, handlers } = createFakePi();
		ifmExtension(pi);
		const handler = handlers.get("session_start")![0]!;
		const { ctx, notifications } = context({
			scopedModels: [{ model: { provider: "anthropic", id: "claude" } }],
			modelRegistry: {
				getAll: () => [{ provider: IFM_PROVIDER_ID, id: "IFM/K2-Horizon-375B-A23B" }],
				getProviderAuthStatus: () => ({ configured: true }),
				getError: () => undefined,
				refresh: async () => ({ aborted: false, errors: new Map() }),
			},
		});
		handler({ type: "session_start" }, ctx);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]!.message).toContain("scoped");
	});
});
