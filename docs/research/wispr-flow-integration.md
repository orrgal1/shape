# Wispr Flow Third-Party Integration Analysis (2026-08-28)

*Scout research brief; links scout-sourced, verify before load-bearing use.*

## 1. Does Wispr Flow Expose a Developer Surface?

**Yes.** Wispr Flow offers an official **Voice Interface API** alongside undocumented local protocols and MCP server capabilities:

- **Official Developer API (WebSocket & REST):**
  - **WebSocket API:** `wss://platform-api.wisprflow.ai/api/v1/dash/ws` (backend auth) and `/client_ws` (frontend short-lived token auth) supporting real-time raw PCM WAV 16kHz audio chunk streaming and streaming transcription delivery ([WebSocket docs](https://api-docs.wisprflow.ai/websocket_api)).
  - **REST API:** `https://platform-api.wisprflow.ai/api/v1/dash/api` for batch audio payloads up to 25MB ([REST docs](https://api-docs.wisprflow.ai/rest_api)).
  - **Developer portal:** `https://platform.wisprflow.ai`, docs at `https://api-docs.wisprflow.ai`. Access currently gated via enterprise request (`enterprise@wisprflow.ai`, [quickstart](https://api-docs.wisprflow.ai/quickstart)).
- **Local protocol handler (URI schemes):**
  - `wispr-flow://start-hands-free` — programmatically starts listening/recording.
  - `wispr-flow://stop-hands-free` — stops recording and commits the transcript ([community source](https://www.reddit.com/r/WisprFlow/comments/1t7g8cn/using_elgato_stream_deck_pedal_to_trigger_wispr/)).
- **MCP:** Wispr Flow provides an MCP server endpoint for IDEs (Claude Code, Cursor, Windsurf) using OAuth PKCE.
- **Unofficial community SDK:** `wisprflow-sdk` (Python, [GitHub](https://github.com/ThisisShashwat/wisprflow-sdk)).

## 2. App-Context Awareness & Custom Vocabulary

**Yes, extensible via API schema** ([client transcribe docs](https://api-docs.wisprflow.ai/client_api_transcribe)):
- **Cursor/text boundaries:** `before_text`, `after_text`, `selected_text` for context-aware spacing/formatting.
- **Application context:** `application.name`, `application.type` (`email`, `ai`, `other`).
- **Visual context:** `screenshot` (base64).
- **DOM/page content:** `content_text`, `content_html`.
- **Conversation state:** `chat_history`, `recent_messages`, `other_participants` for name spelling/entity recognition.

This is exactly what deictic steering needs: on bubble-click, inject the selected component name, neighbors, and edge labels — dictation returns with component names spelled right.

## 3. Documented Partnerships & Integrations

- **AI IDEs / coding agents:** native MCP integration with Claude Code, Cursor, Windsurf ([what's new](https://wisprflow.ai/whats-new)).
- **Local workflow orchestration:** Stream Deck pedals via URI schemes; SQLite DB watchers (e.g. [`wispr-action`](https://github.com/saharmor/wispr-action)) triggering LLM actions from spoken trigger words.

## 4. Integration Strategies, Deepest → Shallowest

1. **Tier 1 — direct in-app WebSocket streaming (Voice Interface API).** Browser captures mic via Web Audio, backend issues short-lived token, streams 16kHz PCM chunks. Real-time partial transcripts + canvas context injection (selected bubble names, active edge relationships). Enterprise-gated today: this is the partnership ask.
2. **Tier 2 — desktop control via `wispr-flow://` URI scheme.** Canvas triggers `start-hands-free` on bubble press, `stop-hands-free` on release; user's stock Wispr install types into a focused input. Works today, no partnership.
3. **Tier 3 — local SQLite tailing.** Tail `~/Library/Application Support/Wispr Flow/flow.sqlite` for committed transcriptions, forward into the canvas event loop.
4. **Tier 4 — focused DOM input capture.** Canvas focuses a contentEditable/textarea on selection; Wispr (or any dictation tool) types; canvas listens to input events. Final text only, no partials, universal fallback.

## 5. Non-Wispr Fallbacks

1. **Deepgram Nova-3** — WebSocket streaming STT, <250ms latency, keyword boosting, official JS/Python SDKs.
2. **OpenAI Realtime API / Whisper streaming.**
3. **Web Speech API / macOS native Speech framework** — zero-dependency floor, lacks code-oriented formatting.
4. **Local whisper.cpp / faster-whisper** — offline/private, for desktop (Electron/Tauri) builds.
