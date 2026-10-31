# Turn orchestration

How one assistant turn is executed, and why the code is split this way.

## Layers

```
components/chat        UI only
store/useChatStream    React composition: conversations, reducer, runner lifecycle
store/turn             React-free turn orchestration
store/stream-machine   pure streaming state machine
lib/*                  domain policies (compaction, sizing, failure policy, ...)
```

Dependency direction is one-way. `store/turn` never imports React or a
component; `lib/*` never imports `store/*`. The UI reads state from the reducer
and calls the hook's actions.

## Modules

| Module | Responsibility | Knows about |
|---|---|---|
| `stream-machine.ts` | Streaming state (`isStreaming`, `parts`, `turn`, `liveUsage`, retry/compaction flags, error) as pure transitions | nothing else |
| `useCompactionNotice.ts` | Transient compaction banner + timer/cleanup | React state |
| `turn/session.ts` | Abort controller, ownership/staleness, one pending retry timer | nothing |
| `turn/persistence.ts` | Turn snapshots, throttled/forced checkpoints, teardown flush, final save | conversation + part types |
| `turn/runner.ts` | The turn itself: prompt prep, `chatStream` wiring, retries, overflow recovery, pre-send and between-step compaction | `lib/*`, `store/storage`, session, persistence |
| `useChatStream.ts` | Conversation selection, reducer, active-runner lifecycle, conversation mutations (`/compact`, delete, regenerate, variants) | all of the above |

## Data flow

```
handleSend
  └─ useChatStream: append user message, persist it, dispatch turn/start
       └─ new TurnRunner(input, ports)
            ├─ prepare: system prompt, settings, OCR availability
            ├─ execute: pre-send compaction (once), projection, fingerprint
            └─ chatStream
                 ├─ onUpdate        → persistence.setParts + dispatch parts + throttled checkpoint
                 ├─ onUsage         → dispatch liveUsage
                 ├─ onStepComplete  → resume snapshot + forced checkpoint
                 ├─ onCompactBeforeStep → durable fold, dispatch compacting, return projection
                 ├─ onCompaction    → wire-fold lifecycle (fallback)
                 ├─ onFinish        → persist (open + save) + dispatch turn/settled
                 └─ onError         → decideStreamFailure:
                                        retry  → session.schedule(next attempt)
                                        overflow → fold once, then retry the turn
                                        fail   → dispatch failed, checkpoint, notify, invalidate
```

The reducer is the only place streaming state changes. The runner emits
`StreamAction`s through a port; it never calls `setState`.

## Invariants

1. **Soft stop vs hard abort.** `TurnSession.abort()` aborts the request but
   keeps ownership, because `chatStream` routes the abort into
   `onFinish('aborted')` and that callback must persist the partial reply and
   swap the streaming bubble for the saved message. `dispose()` (switch,
   teardown) drops ownership so the abort path cannot write into a newer turn.
   `isCurrent()` deliberately ignores the abort signal; only ownership counts.

2. **Settled turns are terminal.** `TurnRunner.persist` sets `settled` before
   saving; `stop()` and `flush()` become no-ops afterwards. Without this, a
   teardown after a finished turn could overwrite the saved message with an
   "interrupted" draft.

3. **Compaction never mixes bases.** A durable between-step fold replaces the
   stored prefix and keeps the live wire tail. Once an in-memory fold has
   rewritten the whole prompt, the durable path is disabled for the rest of the
   run; otherwise a second durable rebuild would append the tail twice.

4. **The current turn is never summarized.** A between-step fold operates on the
   stored conversation (which excludes the in-flight assistant turn) and hands
   the loop a projection; the loop keeps the turn's wire messages as a tail.

5. **The hook owns no turn internals.** It keeps only the active runner handle,
   the resume snapshot mirror, the turn identity mirror and the notice. All
   per-turn mutable state lives in the runner and dies with it.

## Extension points

- **New turn lifecycle step**: add a method to `TurnRunner` and a `StreamAction`
  if it needs UI state; do not add setters to the hook.
- **New failure policy**: extend `lib/stream-failure.ts`; the runner only
  dispatches the returned action.
- **New compaction trigger**: call `compactTurn` (or the runner's compactor)
  rather than duplicating plan/summarize/apply.
- **New persisted field**: `TurnPersistence` is the only place that builds the
  assistant message.
