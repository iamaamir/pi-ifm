# pi-ifm

`pi-ifm` connects Pi to the IFM hosted API at `https://api.ifm.ai/v1`. It finds the chat models that your API key can use, stores that list for offline startup, and streams through Pi's OpenAI Completions adapter. You do not need to edit `models.json`.

## Install

```bash
pi install git:github.com/iamaamir/pi-ifm
```

Try it without installing:

```bash
pi -e git:github.com/iamaamir/pi-ifm
```

## Authenticate

Set an environment variable. `IFM_API_TOKEN` is checked first, then `IFM_API_KEY`:

```bash
export IFM_API_KEY="IFM-..."
```

Or log in once inside Pi:

```text
/login ifm
```

Pi stores the credential in its normal credential store. `pi-ifm` does not log or write the key anywhere else.

## Use

After authentication, IFM models appear in the standard model picker:

```bash
pi --list-models ifm
```

```text
/model
```

Select a model and start working. Model discovery runs at startup, after login, and when you refresh. Discovery does not run for each chat message.

## Commands

| Command | Purpose |
|---|---|
| `/ifm status` | Show credential readiness, catalog freshness, model count, compatibility state, and discovery errors. |
| `/ifm refresh` | Force a live catalog refresh. Keeps the last catalog if the request fails. |
| `/ifm config` | Configure the IFM base URL interactively. Reload or restart Pi after changing it. |

## Model discovery

`pi-ifm` reads the authenticated `GET /v1/models` endpoint. For every entry that is not an obvious non-chat family (speech, embeddings, and so on), it confirms chat support with a one-token `/chat/completions` probe. Model IDs are used exactly as IFM returns them.

The successful catalog is cached by Pi and restored on the next launch, so Pi started without network still shows the last known models. A failed or empty refresh never replaces a healthy catalog.

IFM's model list does not publish output limits, prices, or per-model capabilities. Known models use their documented context windows; other models use conservative defaults. You can override any field per model through `models.json` if your account needs different limits.

## Wire compatibility

Verified against `api.ifm.ai`:

- Text-only user content arrays are converted to strings. IFM rejects typed content arrays with `Invalid value for 'messages.content'`.
- `store` is disabled (`supportsStore: false`).
- The unsupported `developer` role is disabled (`supportsDeveloperRole: false`).
- Reasoning effort is sent as a top-level `reasoning_effort` field.
  IFM's hosted endpoint currently loops when asked for `medium` reasoning, so Pi's default `medium` is mapped to IFM `low`; `high` and above map to IFM `high`. Use `/think high` for deeper reasoning.
- Every replayed assistant message includes a thinking field. `reasoning_content` is the canonical field. An empty string is valid. A missing or null field causes a 400 error.
- Traces are replayed verbatim, so multi-turn history stays consistent.
- Session routing uses one stable `X-Session-ID` for the whole conversation.
- The base URL can be changed with `IFM_BASE_URL` or `/ifm config`.
- System, assistant, tool-call, and tool-result messages are passed through unchanged, so tool-call correlation IDs and multi-turn history are preserved.
- Image and multimodal input are not supported by IFM. `pi-ifm` fails with a clear error instead of silently dropping the attachment.
- `thinking_token_budget`, `tool_call_format`, and `tool_presentation_format` were tested and are rejected by the current API, so they are not sent.

Pi's own streaming, tool-call parsing, usage accounting, cancellation, and retry handling are used unchanged. Streaming tool calls, tool results, follow-up completions, and cancellation were verified live against the hosted API.

## Diagnostics

If an IFM response identifies a model different from the one Pi requested, `/ifm status` and a one-time warning explain the mismatch. The requested model id is never silently rewritten.

## Known limitations

- `GET /v1/models` publishes no per-model metadata. Known models use documented context windows; other models use conservative defaults (131,072-token context, 32,768 output tokens, zero cost). Override a model in `models.json` to change these.
- IFM chat models return a `reasoning` field and support tool calling; both are enabled for every discovered chat model.
- `/login ifm` and `IFM_API_KEY` both work in a normal Pi session. Use `/ifm status` to check auth.

## Development

```bash
npm install
npm test
npm run typecheck
```

Tests use mock HTTP fixtures for discovery, refreshes, malformed responses, catalog outages, request normalization, and command behavior.

## License

MIT
