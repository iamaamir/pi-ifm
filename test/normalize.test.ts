import { describe, expect, test } from "bun:test";
import { normalizeIfmRequestPayload } from "../src/normalize.ts";

describe("normalizeIfmRequestPayload", () => {
	test("joins text-only user content arrays into a string", () => {
		const payload = {
			model: "IFM/K2-Horizon-375B-A23B",
			messages: [
				{ role: "system", content: "be terse" },
				{
					role: "user",
					content: [
						{ type: "text", text: "first" },
						{ type: "text", text: "second" },
					],
				},
			],
		};
		const result = normalizeIfmRequestPayload(payload) as typeof payload;
		expect(result.messages[1]!.content).toBe("first\nsecond");
		expect(result.messages[0]).toBe(payload.messages[0]);
	});

	test("leaves string content untouched by identity", () => {
		const payload = { messages: [{ role: "user", content: "hello" }] };
		expect(normalizeIfmRequestPayload(payload)).toBe(payload);
	});

	test("preserves tool calls and tool results", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call_1", type: "function", function: { name: "t", arguments: "{}" } }],
				},
				{ role: "tool", tool_call_id: "call_1", content: "result" },
			],
		};
		expect(normalizeIfmRequestPayload(payload)).toBe(payload);
	});

	test("leaves assistant content arrays untouched", () => {
		const payload = {
			messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
		};
		expect(normalizeIfmRequestPayload(payload)).toBe(payload);
	});

	test("throws a clear error for image content", () => {
		const payload = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
					],
				},
			],
		};
		expect(() => normalizeIfmRequestPayload(payload)).toThrow(/does not accept image/);
	});

	test("ignores payloads without a messages array", () => {
		expect(normalizeIfmRequestPayload(null)).toBeNull();
		expect(normalizeIfmRequestPayload({ foo: 1 })).toEqual({ foo: 1 });
	});
});
