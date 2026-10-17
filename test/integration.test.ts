import { describe, expect, test } from "bun:test";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { IFM_DEFAULT_BASE_URL } from "../src/constants.ts";
import { createIfmDiscovery } from "../src/discovery.ts";
import { normalizeIfmRequestPayload } from "../src/normalize.ts";
import { createIfmProvider } from "../src/provider.ts";

const MODEL_ID = "IFM/K2-Horizon-375B-A23B";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sse(events: unknown[]): Response {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function chunk(delta: unknown, extra: Record<string, unknown> = {}): unknown {
	return {
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		created: 1,
		model: MODEL_ID,
		choices: [{ index: 0, delta, ...extra }],
	};
}

async function buildProvider(
	chat: Response,
	captured: { body?: any },
): Promise<{ provider: ReturnType<typeof createIfmProvider>; fetchImpl: typeof fetch }> {
	const fetchImpl = (async (input: any, init?: any) => {
		const url = String(input);
		if (url.endsWith("/models")) {
			return json({ object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "MBZUAI" }] });
		}
		if (url.endsWith("/chat/completions")) {
			captured.body = JSON.parse(String(init?.body ?? "{}"));
			return chat;
		}
		return json({ error: { message: `unexpected ${url}` } }, 404);
	}) as typeof fetch;

	const discovery = createIfmDiscovery({ fetchImpl, sleep: async () => {}, probeChat: async () => "chat" });
	const provider = createIfmProvider({ discovery });
	await provider.refreshModels?.({
		credential: { type: "api_key", key: "test-key" },
		allowNetwork: true,
		signal: new AbortController().signal,
		baseUrl: IFM_DEFAULT_BASE_URL,
		publish: async (publication) => {
			publication.update?.();
			return true;
		},
	});
	return { provider, fetchImpl };
}

async function collect(stream: AsyncIterable<any>): Promise<any[]> {
	const events: any[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("provider streaming through the OpenAI Completions adapter", () => {
	test("streams text and normalizes the IFM request payload", async () => {
		const captured: { body?: any } = {};
		const { provider, fetchImpl } = await buildProvider(
			sse([
				chunk({ role: "assistant" }),
				chunk({ content: "Hel" }),
				chunk({ content: "lo" }),
				chunk({}, { finish_reason: "stop" }),
			]),
			captured,
		);
		const model = provider.getModels()[0]!;
		const context = normalizeContext({
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }] } as any],
		});
		const events = await collect(
			provider.streamSimple(model, context, {
				apiKey: "test-key",
				reasoning: "medium",
				fetch: fetchImpl,
				onPayload: (payload) => normalizeIfmRequestPayload(payload),
			}),
		);
		const done = events.find((event) => event.type === "done");
		expect(done?.message.content.map((block: any) => block.text).join("")).toBe("Hello");
		expect(done?.message.stopReason).toBe("stop");
		// The extension hook converted the typed array to a string before send.
		expect(captured.body.messages[0].content).toBe("hi");
		expect(captured.body.store).toBeUndefined();
		expect(captured.body.reasoning_effort).toBe("low");
		expect(captured.body.temperature).toBe(0.2);
		expect(captured.body.chat_template_kwargs).toBeUndefined();
	});

	test("streams a tool call with parsed arguments", async () => {
		const captured: { body?: any } = {};
		const { provider, fetchImpl } = await buildProvider(
			sse([
				chunk({ role: "assistant" }),
				chunk({
					tool_calls: [
						{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":' } },
					],
				}),
				chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
				chunk({}, { finish_reason: "tool_calls" }),
			]),
			captured,
		);
		const model = provider.getModels()[0]!;
		const context = normalizeContext({
			messages: [{ role: "user", content: [{ type: "text", text: "weather?" }] } as any],
			tools: [
				{
					name: "get_weather",
					description: "Get the weather",
					parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } as any,
				},
			],
		});
		const events = await collect(
			provider.streamSimple(model, context, {
				apiKey: "test-key",
				fetch: fetchImpl,
				onPayload: (payload) => normalizeIfmRequestPayload(payload),
			}),
		);
		const done = events.find((event) => event.type === "done");
		const toolCall = done?.message.content.find((block: any) => block.type === "toolCall");
		expect(toolCall?.name).toBe("get_weather");
		expect(toolCall?.arguments).toEqual({ city: "Paris" });
		expect(done?.message.stopReason).toBe("toolUse");
	});

	test("preserves tool-call correlation ids across a tool result", async () => {
		const captured: { body?: any } = {};
		const { provider, fetchImpl } = await buildProvider(
			sse([chunk({ role: "assistant" }), chunk({ content: "18C in Paris" }), chunk({}, { finish_reason: "stop" })]),
			captured,
		);
		const model = provider.getModels()[0]!;
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "weather?", timestamp: 1 } as any,
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "get_weather", arguments: { city: "Paris" } }],
					api: "openai-completions",
					provider: "ifm",
					model: MODEL_ID,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				} as any,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "get_weather",
					content: [{ type: "text", text: "18C" }],
					isError: false,
					timestamp: 1,
				} as any,
			],
		});
		await collect(
			provider.streamSimple(model, context, {
				apiKey: "test-key",
				fetch: fetchImpl,
				onPayload: (payload) => normalizeIfmRequestPayload(payload),
			}),
		);
		const assistant = captured.body.messages.find((message: any) => message.tool_calls);
		const tool = captured.body.messages.find((message: any) => message.role === "tool");
		expect(assistant.tool_calls[0].id).toBe("call_1");
		expect(tool.tool_call_id).toBe("call_1");
		expect(tool.content).toBe("18C");
	});

	test("cancels an in-flight stream through the abort signal", async () => {
		const encoder = new TextEncoder();
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: "A" }))}\n\n`));
			},
		});
		const captured: { body?: any } = {};
		const { provider, fetchImpl } = await buildProvider(
			new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
			captured,
		);
		const model = provider.getModels()[0]!;
		const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 } as any] });
		const controller = new AbortController();
		const pending = collect(
			provider.streamSimple(model, context, { apiKey: "test-key", fetch: fetchImpl, signal: controller.signal }),
		);
		setTimeout(() => controller.abort(), 50);
		const events = await pending;
		const error = events.find((event) => event.type === "error");
		expect(error?.reason).toBe("aborted");
	});

	test("surfaces a provider error without rewriting it", async () => {
		const captured: { body?: any } = {};
		const { provider, fetchImpl } = await buildProvider(
			json({ error: { message: "store: property 'store' is unsupported", type: "invalid_request_error" } }, 400),
			captured,
		);
		const model = provider.getModels()[0]!;
		const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 } as any] });
		const events = await collect(provider.streamSimple(model, context, { apiKey: "test-key", fetch: fetchImpl }));
		const error = events.find((event) => event.type === "error");
		expect(error?.error.errorMessage).toContain("store");
	});
});
