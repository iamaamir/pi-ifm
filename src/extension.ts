/**
 * pi-ifm extension entry point.
 *
 * Registers the native IFM provider, normalizes text-only request payloads for
 * IFM's wire format, reports upstream model-routing mismatches, and exposes
 * `/ifm status` and `/ifm refresh`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	IFM_API_KEY_ENV,
	IFM_DEFAULT_BASE_URL,
	IFM_PROVIDER_ID,
} from "./constants.ts";
import { createIfmDiscovery } from "./discovery.ts";
import { normalizeIfmRequestPayload } from "./normalize.ts";
import { createIfmProvider } from "./provider.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Count IFM chat models currently known to Pi. */
function ifmModelCount(ctx: ExtensionContext): number {
	return ctx.modelRegistry.getAll().filter((model) => model.provider === IFM_PROVIDER_ID).length;
}

/**
 * Explain when a session model scope hides IFM models. Scope is never mutated.
 */
function describeScopeWarning(ctx: ExtensionContext): string | undefined {
	if (ctx.scopedModels.length === 0) return undefined;
	const hasIfmScope = ctx.scopedModels.some((entry) => entry.model.provider === IFM_PROVIDER_ID);
	if (hasIfmScope) return undefined;
	if (ifmModelCount(ctx) === 0) return undefined;
	return (
		"IFM models are available but the current session model scope excludes them. " +
		"Run `/scoped-models` (or start with `--models ifm/*`) to include IFM."
	);
}

function formatStatus(ctx: ExtensionContext, discovery: ReturnType<typeof createIfmDiscovery>): string {
	const auth = ctx.modelRegistry.getProviderAuthStatus(IFM_PROVIDER_ID);
	const authLine = auth.configured
		? `configured${auth.label ? ` (${auth.label})` : ""}`
		: `not configured — set ${IFM_API_KEY_ENV} or run /login ${IFM_PROVIDER_ID}`;

	const state = discovery.state();
	const modelCount = ifmModelCount(ctx);
	const offline = process.env.PI_OFFLINE !== undefined;
	let catalogLine: string;
	if (state.lastSource === "network" && state.lastSuccessAt) {
		catalogLine = `live; last refresh ${new Date(state.lastSuccessAt).toISOString()}`;
	} else if (state.lastAttemptAt) {
		const success = state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : "never";
		catalogLine = `cached; last attempt ${new Date(state.lastAttemptAt).toISOString()}; last success ${success}`;
	} else if (modelCount > 0) {
		catalogLine = `cached (restored from Pi's catalog${offline ? "; offline mode" : ""}); no refresh this session`;
	} else {
		catalogLine = `none${offline ? " (offline mode)" : ""}; run /ifm refresh`;
	}

	const lines = [
		`IFM provider (${IFM_PROVIDER_ID})${offline ? " [offline]" : ""}`,
		`auth: ${authLine}`,
		`models: ${modelCount}`,
		`catalog: ${catalogLine}`,
		"compat: store disabled, developer role disabled, reasoning via top-level reasoning_effort",
	];
	if (state.lastError) lines.push(`discovery error: ${state.lastError}`);
	const registryError = ctx.modelRegistry.getError();
	if (registryError) lines.push(`registry error: ${registryError}`);
	const scopeWarning = describeScopeWarning(ctx);
	if (scopeWarning) lines.push(`scope: ${scopeWarning}`);
	return lines.join("\n");
}

const THINK_CLOSE_TAGS = ["</ifm|think_faster>", "</ifm|think_fast>", "</ifm|think>"];
const THINK_OPEN_TAGS = ["<ifm|think_faster>", "<ifm|think_fast>", "<ifm|think>"];

function splitOnThinkTag(text: string): [string, string] | null {
	let t = text;
	for (const open of THINK_OPEN_TAGS) {
		if (t.startsWith(open)) {
			t = t.slice(open.length);
			break;
		}
	}
	let best = -1;
	let bestLen = 0;
	for (const close of THINK_CLOSE_TAGS) {
		const i = t.indexOf(close);
		if (i !== -1 && (best === -1 || i < best)) {
			best = i;
			bestLen = close.length;
		}
	}
	if (best === -1) return null;
	return [t.slice(0, best), t.slice(best + bestLen)];
}

export function makeIfmCleaner() {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let seenReasoningField = false;
	let emitted = false;
	let buffer = "";
	let carried = "";

	function contentLine(text: string): string {
		return "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
	}

	function takeBuffer(): string | null {
		if (!buffer || emitted) {
			buffer = "";
			return null;
		}
		const held = buffer;
		buffer = "";
		emitted = true;
		return contentLine(held);
	}

	function rewriteLine(line: string): string[] {
		if (!line.startsWith("data: ")) return [line];
		const raw = line.slice(6);
		if (raw === "[DONE]") return [line];
		let obj: any;
		try {
			obj = JSON.parse(raw);
		} catch {
			return [line];
		}
		const delta = obj?.choices?.[0]?.delta;
		if (!delta) return [line];

		if (delta.reasoning || delta.reasoning_content) {
			seenReasoningField = true;
			const pre = takeBuffer();
			return pre ? [pre, line] : [line];
		}

		if (typeof delta.content === "string" && delta.content !== "") {
			if (seenReasoningField || emitted) {
				emitted = true;
				return [line];
			}
			buffer += delta.content;
			const cut = splitOnThinkTag(buffer);
			if (cut) {
				const [reasoning, rest] = cut;
				buffer = "";
				emitted = true;
				const nd = { ...delta, content: rest };
				if (reasoning) nd.reasoning_content = reasoning;
				obj.choices[0].delta = nd;
				return ["data: " + JSON.stringify(obj)];
			}
			return [];
		}

		const pre = takeBuffer();
		return pre ? [pre, line] : [line];
	}

	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			carried += decoder.decode(chunk, { stream: true });
			const lines = carried.split("\n");
			carried = lines.pop() ?? "";
			for (const line of lines) {
				for (const out of rewriteLine(line.trimEnd())) {
					controller.enqueue(encoder.encode(out + "\n\n"));
				}
			}
		},
		flush(controller) {
			if (carried) {
				for (const out of rewriteLine(carried.trimEnd())) {
					controller.enqueue(encoder.encode(out + "\n\n"));
				}
			}
			const pre = takeBuffer();
			if (pre) controller.enqueue(encoder.encode(pre + "\n\n"));
			controller.terminate();
		},
	});
}

export default async function ifmExtension(pi: ExtensionAPI): Promise<void> {
	const discovery = createIfmDiscovery();
	const baseUrl = process.env.IFM_BASE_URL ?? IFM_DEFAULT_BASE_URL;
	const provider = createIfmProvider({ discovery, baseUrl });

	// Warm the catalog at startup, bounded so startup never hangs.
	if (!process.env.PI_OFFLINE) {
		const key = (process.env.IFM_API_TOKEN || process.env.IFM_API_KEY || "").trim();
		if (key) {
			try {
				await Promise.race([
					provider.refreshModels?.({
						credential: { type: "api_key", key },
						allowNetwork: true,
						signal: new AbortController().signal,
						baseUrl,
						publish: async (publication) => {
							publication.update?.();
							return true;
						},
					}),
					new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
				]);
			} catch {
				// Keep the static/last-known catalog.
			}
		}
	}

	pi.registerProvider(provider);

	pi.on("before_provider_headers", (event, ctx) => {
		if (ctx.model?.provider !== IFM_PROVIDER_ID) return;
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (typeof sessionId === "string" && sessionId.length > 0) {
			event.headers = { ...event.headers, "X-Session-ID": sessionId };
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== IFM_PROVIDER_ID) return;
		return normalizeIfmRequestPayload(event.payload);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event?.message;
		if (!message || message.role !== "assistant") return;
		if (message.stopReason !== "error") return;
		if (message.provider !== IFM_PROVIDER_ID && ctx?.model?.provider !== IFM_PROVIDER_ID) return;

		const errorMessage = message.errorMessage ?? "";
		if (errorMessage.includes("context_length_exceeded")) return;
		if (!/request_too_large|exceeds the model context/i.test(errorMessage)) return;

		return {
			message: {
				...message,
				errorMessage: `context_length_exceeded: ${errorMessage}`,
			},
		};
	});

	const reportedMismatches = new Set<string>();
	pi.on("provider_stream_event", (event, ctx) => {
		if (event.provider !== IFM_PROVIDER_ID) return;
		const actual = isRecord(event.data) && typeof event.data.model === "string" ? event.data.model : undefined;
		if (!actual || actual === event.model) return;
		const key = `${event.model}\u0000${actual}`;
		if (reportedMismatches.has(key)) return;
		reportedMismatches.add(key);
		ctx.ui.notify(
			`IFM response identifies model "${actual}" while "${event.model}" was requested. ` +
				"IFM may route to an upstream model; the requested id was not changed.",
			"warning",
		);
	});

	pi.on("session_start", (_event, ctx) => {
		const warning = describeScopeWarning(ctx);
		if (warning) ctx.ui.notify(warning, "warning");
	});

	pi.registerCommand("ifm", {
		description: "IFM provider status and model catalog refresh",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "status", label: "status", description: "Show provider status" },
				{ value: "refresh", label: "refresh", description: "Refresh the model catalog" },
			];
			const trimmed = prefix.trim();
			return items.filter((item) => item.value.startsWith(trimmed));
		},
		handler: async (args, ctx) => {
			const subcommand = args.trim().split(/\s+/)[0] ?? "status";

			if (subcommand === "refresh") {
				const result = await ctx.modelRegistry.refresh({ providers: [IFM_PROVIDER_ID], force: true });
				const error = result.errors.get(IFM_PROVIDER_ID);
				if (error) {
					ctx.ui.notify(`IFM refresh failed: ${error.message}`, "error");
					return;
				}
				ctx.ui.notify(`IFM catalog refreshed: ${ifmModelCount(ctx)} chat model(s).`, "info");
				return;
			}

			if (subcommand === "status" || subcommand === "") {
				ctx.ui.notify(formatStatus(ctx, discovery), "info");
				return;
			}

			ctx.ui.notify("Usage: /ifm [status|refresh]", "warning");
		},
	});

	// Patch fetch once per process to repair leaked reasoning in SSE streams.
	const ifmHost = baseUrl.replace(/^https?:\/\//, "").split("/")[0] || "api.ifm.ai";
	const g = globalThis as any;
	if (!g.__ifmFetchPatched) {
		g.__ifmFetchPatched = true;
		const origFetch = globalThis.fetch.bind(globalThis);
		g.fetch = async (input: any, init?: any) => {
			const res = await origFetch(input, init);
			try {
				const url =
					typeof input === "string"
						? input
						: input instanceof URL
							? input.href
							: input?.url;
				if (!url || !url.includes(ifmHost)) return res;
				const ct = res.headers?.get?.("content-type") ?? "";
				if (!ct.includes("event-stream") || !res.body) return res;
				return new Response(res.body.pipeThrough(makeIfmCleaner()), {
					status: res.status,
					statusText: res.statusText,
					headers: res.headers,
				});
			} catch {
				return res;
			}
		};
	}
}
