import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ifmExtension from "../src/extension.ts";
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
