# Sessions and /resume

Synax persists sessions so you can resume previous work.

## Session Storage

Sessions are stored under `~/.local/share/synax/sessions/`:

```
~/.local/share/synax/sessions/
  index.json              # Lightweight metadata index
  sessions/
    2026/
      05/
        20260507120000123-abc4.jsonl   # Append-only event log
```

The index contains metadata (title, branch, provider/model, message and event counts, status, timestamps) for fast listing.
Full event logs are stored as JSONL and read only during resume.

## What's Stored

Each session records:

| Metadata                   | Event Log              |
| -------------------------- | ---------------------- |
| Session ID                 | User messages          |
| Created/updated timestamps | Assistant messages     |
| Workspace path             | Tool calls and results |
| Git branch                 | State snapshots        |
| Active provider/model      | Summaries              |
| Message/event counts       |                        |
| Session status             |                        |

## /resume Command

From the TUI, press `/` and type `resume`:

```
/resume  Resume previous session
```

This opens the session picker. Empty sessions with no restorable conversation messages are hidden:

```
Resume Previous Session                         Sort: Updated
Type to search

  Created        Updated        Msgs Status     Branch      Model       Conversation
> 15 min ago     12 min ago        4 active     dev/tui     qwen-local  Fix Synax TUI input corruption bugs...
  31 min ago     28 min ago        2 completed  dev/tui     qwen-local  Please look at specs/synax-ai-core...
  2 hours ago    2 hours ago       6 failed     main        llama.cpp   Implement provider settings runtime...

enter to resume    esc close    ctrl+d quit    tab sort    up/down browse
```

## Picker Controls

| Key    | Action                        |
| ------ | ----------------------------- |
| ↑ / ↓  | Browse sessions               |
| Enter  | Resume selected session       |
| Escape | Close picker                  |
| Ctrl+D | Quit Synax                    |
| Tab    | Toggle sort (updated/created) |
| Type   | Filter sessions by text       |

## Resume Behavior

When you resume a session:

1. The conversation context is restored
2. The current runtime provider/model remains active
3. User and assistant messages are restored behind the stable system/skill prefix
4. Tool calls, tool results, and state snapshots remain in the JSONL log but are not replayed into model-visible context
5. The resumed session is marked active and ready for the next message

## Session Lifecycle

- Sessions are created automatically when you start typing in the TUI
- Events are appended in real-time as the agent works
- The index is updated on every event
- Sessions with no messages are kept in storage but omitted from `/resume`
- Old sessions (>200) are pruned automatically

## Performance

- The resume picker reads only the metadata index (~KB), not full transcripts
- Only the selected session's event log is read on-demand during resume
- Resume keeps volatile UI notices out of model-visible context to preserve prompt-cache-friendly prefixes
- Session storage is append-only JSONL for reliability
- Maximum 200 sessions retained

## Limitations (Current)

- Sessions are not synced across machines
- No semantic search over session history
- Session export/import is planned
