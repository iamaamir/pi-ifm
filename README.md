# pi-ifm

IFM (Institute of Foundation Models) provider for [Pi](https://pi.dev).

`pi-ifm` connects Pi to the IFM hosted API at `https://api.ifm.ai/v1`. It
discovers the chat models available to your API key, stores the catalog for
offline startup, and streams through Pi's OpenAI Completions adapter. You do not
need to edit `models.json`.

## Install

```bash
pi install npm:pi-ifm
```

## Authenticate

Either set an environment variable:

```bash
export IFM_API_KEY="IFM-..."
```

Or authenticate once inside Pi:

```text
/login ifm
```

Pi stores the credential in its normal credential store. `pi-ifm` never logs or
writes the key anywhere else.

## Use

After authentication, IFM models appear in the standard model picker:

```bash
pi --list-models ifm
```

```text
/model
```

Select a model and start working. Model discovery runs at startup, after login,
and when you refresh. Discovery is never triggered per chat message.

## Commands

| Command | Purpose |
|---|---|
| `/ifm status` | Show credential readiness, catalog freshness, model count, compatibility state, and discovery errors. |
| `/ifm refresh` | Force a live catalog refresh. Keeps the last catalog if the request fails. |

## Model discovery

`pi-ifm` reads the authenticated `GET /v1/models` endpoint. For every entry that
is not an obvious non-chat family (speech, embeddings, and so on), it confirms
chat support with a one-token `/chat/completions` probe. Model IDs are used
exactly as IFM returns them.

The successful catalog is cached by Pi and restored on the next launch, so a
Pi started without network still shows the last known models. A failed or empty
refresh never replaces a healthy catalog.

IFM's model list does not publish context windows, output limits, prices, or
per-model capabilities. `pi-ifm` therefore uses conservative defaults for every
discovered chat model. You can override any field per model through `models.json`
if your account needs different limits.

## Wire compatibility

Verified against `api.ifm.ai`:

- Text-only user content arrays are converted to strings. IFM rejects typed
  content arrays with `Invalid value for 'messages.content'`.
- `store` is disabled (`supportsStore: false`).
- The unsupported `developer` role is disabled (`supportsDeveloperRole: false`).
- Reasoning effort is sent through `chat_template_kwargs.reasoning_effort`.
  IFM's hosted endpoint currently loops when asked for `medium` reasoning, so
  Pi's default `medium` is mapped to IFM `low`; `high` and above map to IFM
  `high`. Use `/think high` for deeper reasoning.
- System, assistant, tool-call, and tool-result messages are passed through
  unchanged, so tool-call correlation IDs and multi-turn history are preserved.
- Image and multimodal input are not supported by IFM. `pi-ifm` fails with a
  clear error instead of silently dropping the attachment.
- `thinking_token_budget`, `tool_call_format`, and `tool_presentation_format`
  were tested and are rejected by the current API, so they are not sent.

Pi's own streaming, tool-call parsing, usage accounting, cancellation, and retry
handling are used unchanged. Streaming tool calls, tool results, follow-up
completions, and cancellation were verified live against the hosted API.

## Diagnostics

If an IFM response identifies a model different from the one Pi requested,
`/ifm status` and a one-time warning explain the mismatch. The requested model
id is never silently rewritten.

## Known limitations

- `GET /v1/models` publishes no per-model metadata. Every discovered chat model
  uses conservative defaults (131,072-token context, 32,768 output tokens, zero
  cost). Override a model in `models.json` to change these.
- IFM chat models return a `reasoning` field and support tool calling; both are
  enabled for every discovered chat model.
- `pi auth check --provider ifm` reports `provider_not_found` because Pi's auth
  check does not load extension providers. Use `/ifm status`, which does.
  `/login ifm` and `IFM_API_KEY` both work in a normal Pi session.

## Development

```bash
bun install
bun test
bun run typecheck
```

Tests use mock HTTP fixtures for discovery, refreshes, malformed responses,
catalog outages, request normalization, and command behavior.

## License

MIT
