/**
 * pi-ifm extension entry point.
 *
 * Registers the native IFM provider, normalizes text-only request payloads for
 * IFM's wire format, reports upstream model-routing mismatches, and exposes
 * `/ifm status` and `/ifm refresh`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IFM_API_KEY_ENV, IFM_PROVIDER_ID } from "./constants.ts";
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
		"compat: store disabled, developer role disabled, reasoning via chat_template_kwargs",
	];
	if (state.lastError) lines.push(`discovery error: ${state.lastError}`);
	const registryError = ctx.modelRegistry.getError();
	if (registryError) lines.push(`registry error: ${registryError}`);
	const scopeWarning = describeScopeWarning(ctx);
	if (scopeWarning) lines.push(`scope: ${scopeWarning}`);
	return lines.join("\n");
}

export default function ifmExtension(pi: ExtensionAPI): void {
	const discovery = createIfmDiscovery();

	pi.registerProvider(createIfmProvider({ discovery }));

	// IFM requires string content for text messages and rejects typed text
	// arrays. Only IFM payloads are touched.
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== IFM_PROVIDER_ID) return;
		return normalizeIfmRequestPayload(event.payload);
	});

	// IFM may route a request to an upstream model whose id differs from the
	// requested one. Surface it once per pair instead of rewriting the model id.
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
}
