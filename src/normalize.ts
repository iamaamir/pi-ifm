/**
 * IFM request normalization.
 *
 * Pi normally converts a user turn into an array of typed content blocks. IFM
 * accepts OpenAI-style string content for text messages and rejects typed
 * arrays with `Invalid value for 'messages.content'`. This hook rewrites only
 * text-only user arrays on the IFM provider. System, assistant, tool-call, and
 * tool-result messages are passed through untouched so tool-call correlation
 * ids and multi-turn history are preserved.
 *
 * Multimodal content is not silently dropped: IFM rejects images, so the hook
 * fails with an actionable message instead of sending an invalid array.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
	return isRecord(part) && part.type === "text" && typeof part.text === "string";
}

function isImagePart(part: unknown): boolean {
	if (!isRecord(part)) return false;
	return part.type === "image" || part.type === "image_url" || part.type === "input_image";
}

/**
 * Normalize one provider payload. Returns the original object when nothing
 * changed. Throws when a user turn contains content IFM cannot accept.
 */
export function normalizeIfmRequestPayload(payload: unknown): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;

	let changed = false;
	const messages = payload.messages.map((message) => {
		if (!isRecord(message) || message.role !== "user") return message;
		if (typeof message.content === "string") return message;
		if (!Array.isArray(message.content)) return message;

		const parts = message.content as unknown[];
		if (parts.length > 0 && parts.every(isTextPart)) {
			changed = true;
			return {
				...message,
				// Preserve the existing behavior of joining multiple text parts
				// with newlines so ordering and separation are kept.
				content: (parts as { text: string }[]).map((part) => part.text).join("\n"),
			};
		}

		if (parts.some(isImagePart)) {
			throw new Error(
				"IFM does not accept image or multimodal message content. Remove the attachment or switch to a provider that supports vision.",
			);
		}
		return message;
	});

	return changed ? { ...payload, messages } : payload;
}
