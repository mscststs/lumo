---
name: webmcp
description: Deep reference for the WebMCP web standard (Web Model Context Protocol). Use when implementing, reviewing, or debugging WebMCP tools in any web app or framework — imperative API (document.modelContext / navigator.modelContext, registerTool, provideContext), declarative API (toolname/tooldescription form attributes, respondWith), tool schemas, annotations, security, best practices, evals, browser support, or when integrating WebMCP into a React/Next.js app (via react-web-mcp) or vanilla JS.
---

# WebMCP — complete reference

WebMCP ("Web Model Context Protocol") is a proposed web standard that lets a web **page** expose client-side functionality as structured *tools* that AI agents can discover and invoke — agents built into the browser (Gemini in Chrome, Copilot in Edge), running in extensions, or embedded by the page author in iframes. Think of it as an in-page MCP server: same vocabulary as backend MCP (tools, JSON Schema inputs, content responses) but web-native (origins, Permissions Policy, DOM, tab lifecycle).

- Spec: https://webmachinelearning.github.io/webmcp/ · Explainer: https://github.com/webmachinelearning/webmcp
- Chrome docs: https://developer.chrome.com/docs/ai/webmcp (imperative-api, declarative-api, best-practices, secure-tools, evals, compare-mcp subpages)
- Official demos/tools: https://github.com/GoogleChromeLabs/webmcp-tools
- Incubated by Microsoft + Google in the W3C Web Machine Learning CG; first published Aug 2025.

## Why it exists

Without WebMCP, agents actuate pages via screenshots, accessibility-tree scraping, and simulated clicks — slow, brittle, multi-step. Backend MCP integrations avoid that but bypass the page entirely (UI disintermediation, replicated auth/state, separate server to build). WebMCP keeps the **user, page, and agent in one shared context**: tools run the page's existing client-side code, the UI updates live, the user keeps visibility and control (human-in-the-loop is an explicit design goal; fully autonomous/headless operation is an explicit non-goal). Agents can still fall back to ordinary UI actuation when no suitable tool exists.

## Availability & enabling (as of mid-2026)

| Channel | Status |
| --- | --- |
| Chrome 146+ | `chrome://flags/#enable-webmcp-testing` (local dev) |
| Chrome 149+ | Origin trial — register, then `<meta http-equiv="origin-trial" content="…">` or `Origin-Trial` header |
| Edge 147+ | Native support |
| Other browsers | Not available — feature-detect and degrade |

API surface history: early Chrome previews shipped `navigator.modelContext`; the spec settled on **`document.modelContext`** and Chrome 150 deprecated the navigator alias. Always resolve as `document.modelContext || navigator.modelContext`.

Feature detection:

```js
const ctx = document.modelContext ?? navigator.modelContext;
if (ctx) { /* register tools */ }
```

## Imperative API

### registerTool(tool, options?)

```js
const controller = new AbortController();

await document.modelContext.registerTool({
  name: "add-todo",
  description: "Add a new item to the user's active todo list",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text content of the todo item" }
    },
    required: ["text"]
  },
  annotations: { readOnlyHint: false, untrustedContentHint: true },
  async execute({ text }) {
    await addTodoItemToCollection(text);          // reuse existing app logic
    return { content: [{ type: "text", text: `Added "${text}".` }] };
  }
}, { signal: controller.signal });

// later: controller.abort() unregisters the tool
```

Tool descriptor fields:

- `name` (required): unique per page, descriptive, kebab/camelCase (`search-flights`, `listFlights`).
- `description` (required): natural language; the agent's only guide for *when* to call it.
- `inputSchema`: JSON Schema object (same vocabulary as backend MCP). Omit or `{}` for no-arg tools. Treat as documentation, not enforcement — validate inside `execute`.
- `outputSchema` (Chrome supports it; spec issue #9): JSON Schema for the structured return value. Official demos wrap results as `{ result: … }`. When present, return the raw structured value.
- `annotations`: hints, not security — `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `untrustedContentHint` (output contains third-party/user content; agents must treat it as untrusted).
- `execute(args)`: sync or async. Return either an MCP `CallToolResult` (`{ content: [{ type: "text", text }], isError? }`) or a plain value/object (implementations stringify). Prefer returning readable error responses over throwing.

Registration options:

- `signal`: `AbortSignal`; aborting unregisters (the canonical unregistration mechanism).
- `exposedTo`: array of secure origins (for author-provided agents in cross-origin iframes). Default exposure: the page itself, same-origin frames, and the built-in browser agent only.

### Other ModelContext members

- `provideContext({ tools: [...] })` — replaces the page's **entire** registered toolset in one call (use on auth/app-state changes). `registerTool` adds incrementally on top.
- `unregisterTool(name)` / `clearContext()` — present in some Chrome versions; feature-detect before calling.
- Lifecycle events — **where they actually fire matters**: Chromium dispatches `toolactivated` (a tool ran / a declarative form was filled awaiting review) and the cancel event at the **window**, and only `toolchange` (toolset changed) at the ModelContext object. Chromium also names the cancel event `toolcancel`, not the explainer's `toolcanceled` (and currently fires it for imperative tools only). The events are `WebMCPEvent`s carrying a `toolName` property. Attach listeners to both targets (and both cancel spellings) to be safe — react-web-mcp's `useWebMCPEvent`/`addWebMCPEventListener` do this for you.
- Registration rejects with `NotAllowedError` DOMException when Permissions Policy disallows it.

### Permissions Policy / iframes

WebMCP is enabled in top-level windows + same-origin iframes by default. Delegate to cross-origin iframes with `<iframe allow="tools">`; disable site-wide with the `Permissions-Policy: tools=()` header. `exposedTo` additionally gates which embedded/embedding origins can see a specific tool.

## Declarative API

HTML forms become tools via attributes — no JS required:

```html
<form
  toolname="book_table"
  tooldescription="Books a table. Accepts customer details, timing, and seating preferences."
>
  <input type="text" name="name" required minlength="2"
         toolparamdescription="Customer's full name (min 2 chars)">
  <select name="seating" toolparamdescription="Seating preference">
    <option value="inside">Inside</option>
    <option value="terrace">Terrace</option>
  </select>
  <button type="submit">Book</button>
</form>
```

- `toolname` + `tooldescription` on `<form>` are **both required** — missing either prevents registration.
- `toolautosubmit` (boolean attribute): lets the agent submit the form itself. **Absent by default**: the browser fills the form, focuses the submit button, and the *user* reviews and submits — the human-in-the-loop safety default. The platform guidance is autosubmit-for-low-stakes-only, but note the tension with the current Chromium hazard below: review mode leaves an invocation pending, and a re-invoke on top of it kills the page's whole tool channel (confirmed in practice). Until that's fixed browser-side, prefer `toolautosubmit` wherever the action is safe to perform immediately, and reserve review mode for genuinely consequential actions guarded by indicators + a reset watchdog.
- The browser **synthesizes the input schema** from form controls: each control's `name` becomes a property; `required` → required; `toolparamdescription` → property description; control types/constraints (`type=number`, `min`, `max`, `step`, `<select>` options…) shape the property schema (exact algorithm still being specced; Chromium ships a loose version).
- Registration/teardown is automatic as annotated forms enter/leave the DOM or attributes change. Form reset or tool-attribute changes cancel in-flight invocations.
- The synthesized schema depends on control **structure** (names, types, `required`, `<option>` values), not current values — agent fills and user typing don't churn registration, but adding/removing/renaming controls re-registers the tool (and cancels a pending invocation with "tool definition was updated").
- Agent fills dispatch real `input`/`change` events on the controls (framework-controlled inputs stay in sync), and `toolactivated` fires only after the fill completes.

### Chromium lifecycle internals — the failure mode to design around

Verified against Chromium's `HTMLFormElement`/`ModelContext` sources:

- **One pending invocation per form.** Each declarative form holds a single reply slot. If the agent invokes the tool again while a previous invocation is still pending (form filled, user hasn't submitted), Chromium **overwrites the slot and drops the older reply callback without answering it** — and a dropped reply closes the document's WebMCP message pipe: **every tool on the page (imperative ones included) silently stops working until reload**. This is the classic "everything broke after a few form-tool calls" symptom, reproduced in practice with re-invokes only seconds apart: each unanswered, re-invoked form call is a landmine. Structural avoidance: `toolautosubmit` (each call is answered immediately). Page-side defenses, in order of robustness: (1) **the staged-answer pattern** — answer every invocation immediately via a synthetic `requestSubmit()` + `respondWith("form filled, awaiting user review")`, so nothing ever stays pending (the user's later review submit carries `agentInvoked: false` and completes as a normal submission; this is `useFormTool`'s semantics, and react-web-mcp `ToolForm`'s default review mode, `reviewResponse: "immediate"`); (2) **the re-invoke guard pattern** for the native pending-until-submit flow: the new invocation's fill dispatches `input` events *before* the old reply slot is overwritten, so a `form.reset()` inside that window answers the old invocation cleanly ("cancelled by a form reset") and saves the channel — detect the fill as an `input` event on an **unfocused** control while a review is pending (user interactions target the focused control), snapshot every control value before the reset and restore after. **Hard limit of the guard, confirmed in practice**: a re-invoke whose fill changes no control values (identical arguments — the common double-send) dispatches no events at all and is invisible to the page; only the staged-answer pattern survives that. Caveat for both: a `reset`-event listener calling `preventDefault()` defeats the reset-cancel path entirely.
- **`form.reset()` is the sanctioned page-side cancel.** Resetting a form with a pending invocation answers the agent with a proper "Tool execution cancelled by a form reset" error, returns the form to idle, and keeps the channel healthy. Use it (a) on a watchdog timeout for stale invocations, (b) as a manual "cancel pending invocation" affordance on test pages.
- **`agentInvoked` is true on the user's review submit.** Any submission that completes a pending invocation carries `agentInvoked: true` — including the human clicking submit after reviewing the agent-filled form. The flag means "this submission answers an agent invocation", not "the agent performed the submission". Handle it with `respondWith`, not with your human-path logic.
- **`respondWith()` rules** (throws `InvalidStateError` otherwise): only on events with `agentInvoked === true`, only **after** `preventDefault()`, and only **synchronously during dispatch** (don't `await` before calling it — pass the pending promise). `preventDefault()` without `respondWith()` is answered browser-side as a site programming error.
- **Without `toolautosubmit`** the browser focuses the submit button and pauses the agent until the user submits; the invocation stays pending indefinitely otherwise. With `toolautosubmit` the browser submits synchronously during the invocation (so `toolactivated` can arrive after the submit handler already ran).
- **Don't reset immediately after answering**: a `reset()` issued before the browser consumed the `respondWith` promise cancels the invocation instead of answering it — defer any post-answer reset by a macrotask.
- **Native validation can eat agent submits**: a form whose agent-filled controls fail constraint validation reports a validation error to the agent (current Chromium) or, in some builds, never fires `submit` at all. Render declarative tool forms `noValidate` and validate in your submit/`onAgentSubmit` handler (re-run `reportValidity()` for human submits).

### Returning a response without navigating

```js
form.addEventListener("submit", (e) => {
  if (e.agentInvoked) {                 // SubmitEvent.agentInvoked: agent vs. user
    e.preventDefault();                 // must precede respondWith
    e.respondWith((async () => {
      const result = await doBooking(new FormData(form));
      return { content: [{ type: "text", text: `Confirmed: ${result.code}` }] };
    })());
  }
});
```

If the form *does* navigate, the proposal is to use the first `<script type="application/ld+json">` on the target page as the tool response (cross-document response handling is still under discussion, spec issue #135).

### CSS pseudo-classes & visual indicators

- `:tool-form-active` — matches a form whose declarative tool is "running" (filled by the agent, awaiting user review/submission).
- `:tool-submit-active` — matches that form's submit button.

The "running" state starts at agent fill and ends when the form is reset or removed, the `respondWith` promise resolves, the tool attributes change, or a `toolautosubmit` submission completes.

**Always give users a visual indicator** on review-style forms — without one, testers and users don't realize the form awaits *their* submit, leave the invocation pending, and trigger the one-pending-invocation failure mode above. Pattern: style `:tool-form-active` and keep a JS-maintained attribute fallback (e.g. `data-webmcp-active="true"` toggled on `toolactivated`/answer/reset) for engines without the pseudo-class; wrap the pseudo-class in `:is()` so unknown-selector parsing can't invalidate the rule. react-web-mcp ships this as `<ToolForm indicators>` + `WEBMCP_INDICATOR_CSS`.

## Security model & secure-tools guidance

Threats to design for:

1. **Prompt injection both ways.** Tool *outputs* are untrusted data to the agent (Chrome treats WebMCP outputs as strictly untrusted; outputs are base64-encoded in transport). Malicious *pages* can hide instructions in tool names/descriptions/params ("malicious manifests") or in responses ("contaminated outputs") — as a tool author, never echo third-party/user-generated content without marking `untrustedContentHint: true`.
2. **The agent is an untrusted client.** Assume any registered tool can be called at any time with arbitrary arguments. Validate every input server-side as usual; client-side schemas are hints. Don't expose tools that bypass authorization the UI would enforce.
3. **Exposure scope.** Default: page + same-origin frames + built-in browser agent. `exposedTo: [origins]` widens to specific secure origins — only ones you'd directly share that data with (even read-only tools leak user data). Disable via Permissions Policy where unneeded.
4. **Human-in-the-loop for consequential actions.** Prefer declarative forms without `toolautosubmit`, or imperative tools that stage changes for user confirmation (e.g. navigate to a checkout rather than charging). Mark `destructiveHint` honestly; browsers/agents may use hints to require confirmation.
5. **Secrets.** Never embed credentials/PII in tool descriptions or schemas; they're shipped to the agent platform.

## Best practices (tool design)

- **Granularity**: one tool = one user-meaningful task (`search-flights`, `apply-filters`, `list-results`) — not one mega-tool, not one tool per DOM node. Expose the page's *current* capabilities; register/unregister as state changes (login, route, selection).
- **Naming/descriptions**: action-oriented names; descriptions that state purpose, when to use it, inputs, and what it returns. Succinct — verbose descriptions and outputs can trip agent guardrails and waste context.
- **Schemas**: describe every property; use `enum`/`min`/`max`/`required` precisely; prefer flat argument objects.
- **Outputs**: compact, structured (JSON), relevant — not HTML dumps. Cap length. For long operations consider returning staged status.
- **Errors**: return `{ isError: true, content: [...] }` with an actionable message ("No results for that date — try a range") so the agent can self-correct; don't throw opaque exceptions.
- **Lifecycle**: register early (agents may query on page load); clean up with `AbortSignal` on SPA route changes/unmounts; `provideContext` to swap toolsets wholesale.
- **Asynchronous UI**: if a tool triggers UI work that completes later, resolve `execute`'s promise only when the action truly finished (the official React demo bridges this with custom events + request IDs and a hard timeout).

## Framework integration gotchas

These apply whatever your framework (React, Vue, Svelte, Angular, vanilla):

- **SSR safety**: never touch `document`/`navigator` at module scope; only inside lifecycle hooks/effects with existence checks. Server renders must be a no-op.
- **Registration timing**: register from mount/effect lifecycle, not during render — render can run multiple times without commit.
- **Re-registration churn**: inline schema object literals change identity every render; key registration on deep equality (e.g. `JSON.stringify` of the definition), and keep the `execute` handler fresh via a ref/closure instead of re-registering.
- **Stale closures**: an `execute` captured at registration time sees old state; route it through a ref or store accessor.
- **Cleanup**: tie registration to an `AbortController` aborted on unmount/route change, or the tool outlives its UI.
- **Unhandled rejections**: `registerTool` can reject (`NotAllowedError` under Permissions Policy) — catch it. Exceptions thrown in `execute` should be converted to `{ isError: true }` responses, never left as unhandled rejections.
- **The API split**: resolve `document.modelContext` first, fall back to `navigator.modelContext`; feature-detect optional members (`provideContext`, `unregisterTool`, `clearContext`).
- **Never leave a declarative invocation pending.** One pending invocation per form (see the Chromium lifecycle internals above); a re-invoke drops the old reply and can kill the page's whole WebMCP channel. Answer promptly, show a visual indicator so the user actually submits, add a stale-invocation watchdog that cancels via `form.reset()`, and implement the re-invoke guard pattern (or use react-web-mcp's `reinvokeGuard`) as the last line of defense.
- **Don't fail silently.** Surface registration failures, validation rejections, unanswered/overlapping invocations, and cancellations to the console and (on test pages) to an on-page log — silent breakage in this API is otherwise close to undebuggable.

## Using React? Use react-web-mcp

For React/Next.js apps, don't hand-roll the above — **[react-web-mcp](https://github.com/cr4yfish/react-web-mcp)** is a zero-dependency React hooks/components package for WebMCP that already handles every gotcha listed above (SSR safety, effect-time registration, churn-free re-registration, fresh closures via refs, abort-based cleanup, error-to-`isError` normalization, the `document`/`navigator` split).

```bash
npm install github:cr4yfish/react-web-mcp   # or pnpm add / yarn add
```

```tsx
import { useWebMCP, useWebMCPTool, useWebMCPEvent, ToolForm,
         toolFormAttrs, toolParamAttrs } from "react-web-mcp";
import { registerTool, provideContext } from "react-web-mcp/vanilla"; // React-free / RSC-safe
```

- `useWebMCPTool({ name, description, inputSchema?, outputSchema?, annotations?, exposedTo?, enabled?, execute })` — registers for the component lifetime; `execute` sees fresh closures without re-registration (ref-based); definition changes (deep-compared via JSON) re-register; `enabled:false` unregisters in place. Returns `{ isRegistered }`.
- `useWebMCP()` → `{ isSupported, modelContext }`, SSR/hydration-safe (false until mounted).
- `useWebMCPEvent("toolchange" | "toolactivated" | "toolcanceled", handler)` — listens on window **and** the ModelContext and handles Chromium's `toolcancel` naming, deduped, so handlers fire in every implementation; events expose `toolName`. Framework-agnostic twin: `addWebMCPEventListener`.
- `<ToolForm name description autoSubmit? reviewResponse? onAgentSubmit? indicators? pendingTimeoutMs? onPendingChange? resetAfterAgentSubmit?>` — declarative form wrapper; `onAgentSubmit(formData, event)` answers agent submissions via `respondWith` without navigation. **`autoSubmit` defaults to `true`** (flipped from the platform default) because of the one-pending-invocation channel-kill hazard above. `autoSubmit={false}` review mode is channel-safe by default (`reviewResponse: "immediate"` — staged answer, user's submit completes as a normal submission, `onAgentSubmit` not called); `reviewResponse: "on-submit"` opts into the native pending-until-submit flow when the agent needs the final data, protected by `reinvokeGuard` (default on) and the watchdog — but an identical-values re-invoke remains uncatchable. `indicators` opts into the visual highlight (pseudo-class + `data-webmcp-active` fallback, `--webmcp-indicator-color` to theme). `pendingTimeoutMs` (default 2 min) is the stale-invocation watchdog that cancels via `form.reset()` so the one-pending-invocation failure mode can't kill the page; overlapping invocations are reported as an `invocation-overlap` error diagnostic. `onPendingChange(pending)` drives custom review UI.
- Verbose mode / diagnostics (nothing fails silently): `setWebMCPVerbose(true)` logs the full lifecycle (`[webmcp]` prefix); `onWebMCPDiagnostic(listener)` streams every diagnostic `{ level, code, message, toolName?, detail? }` for on-page debug logs — codes include `invocation-overlap`, `invocation-timeout`, `respondwith-missing`, `agent-response-error`, `invalid-arguments`, `register-failed`.
- Core (`react-web-mcp/vanilla`, no React import): `getModelContext`, `isWebMCPSupported`, `registerTool` (returns `unregister()`; wraps execute with normalization + error-to-`isError`), `provideContext`, `textResult`, `jsonResult` (truncates at 50k chars), `toolFormAttrs`, `toolParamAttrs`, plus the diagnostics, event, and indicator helpers above. Usable from any framework, not just React.
- Everything is a no-op without browser support — safe to ship unconditionally.
- Next.js: main entry has `"use client"`; call hooks from client components. Add the origin-trial `<meta>` in the root layout for production.

## Testing, debugging, evals

- **Chrome DevTools → WebMCP panel** (`developer.chrome.com/docs/devtools/application/webmcp`): live list of registered tools + schemas, chronological invocation log, manual invocation, built-in Gemini integration to exercise tools with natural language, "Copy trace" for regression tracking.
- **Model Context Tool Inspector** (Chrome extension, github.com/beaufortfrancois/model-context-tool-inspector): verify exposure, visualize schemas.
- **WebMCP Evals CLI** (github.com/GoogleChromeLabs/webmcp-tools `evals-cli/`): define eval cases as `{ messages: [{role:"user", content:"…"}], expectedCall: [{ functionName, arguments }] }`; run against a static `schema.json` (`runevals`) or against the live page's tools via Puppeteer + Chrome Canary with the WebMCP flag (`webmcpevals`). Backends: Gemini (primary), Ollama/Vercel AI SDK (experimental). Generates HTML pass-rate reports. Iterate on names/descriptions/schemas until models reliably pick the right tool with the right args.
- **react-web-mcp verbose mode**: on test pages, `setWebMCPVerbose(true)` + `onWebMCPDiagnostic` give a complete lifecycle trail (invocations, responses, cancellations, overlaps) in the console and your own UI — the fastest way to catch a silently-dying tool channel.
- **Unit tests**: mock the ModelContext — an `EventTarget` exposing `registerTool` that honors `options.signal` for unregistration (see `tests/mock-model-context.ts` in react-web-mcp for a reference implementation).
- **Official demo corpus** for reference patterns: `demos/react-flightsearch` (imperative React + outputSchema), `demos/french-bistro` (declarative form), `demos/hotel-chain` & `demos/doors` (both styles), `demos/page-agent` (Gemini-driven meta-agent).

## WebMCP vs. backend MCP

| | Backend MCP | WebMCP |
| --- | --- | --- |
| Runs | Your server (stdio/HTTP, JSON-RPC) | The user's browser tab, page JS |
| Auth/state | Replicated server-side | The user's existing session, as-is |
| UI | Bypassed | Shared & live-updated; user can intervene |
| Reach | Works without a browser, background, headless | Page must be open; human-in-the-loop |
| Security posture | Tool logic never reaches the client | Tool logic is client-visible; browser mediates |
| Best for | Server actions, data APIs, automation | Interactive flows, anything keyed to UI state |

They compose: many products ship backend MCP for server operations *and* WebMCP for in-page interaction.
