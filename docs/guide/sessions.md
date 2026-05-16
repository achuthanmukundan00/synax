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

The index contains metadata (title, branch, timestamps) for fast listing.
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

This opens the session picker:

```
Resume Previous Session                         Sort: Updated
Type to search

  Created        Updated        Branch      Conversation
→ 15 min ago     12 min ago     dev/tui     Fix Synax TUI input corruption bugs...
  31 min ago     28 min ago     dev/tui     Please look at specs/synax-ai-core...
  2 hours ago    2 hours ago    main        Implement provider settings runtime...

enter to resume    esc to start new    ctrl+d to quit    tab to toggle sort    ↑/↓ to browse
```

## Picker Controls

| Key    | Action                        |
| ------ | ----------------------------- |
| ↑ / ↓  | Browse sessions               |
| Enter  | Resume selected session       |
| Escape | Close picker, start new       |
| Ctrl+D | Quit Synax                    |
| Tab    | Toggle sort (updated/created) |
| Type   | Filter sessions by text       |

## Resume Behavior

When you resume a session:

1. The conversation context is restored
2. Provider/model settings are restored if still available
3. If the provider/model is missing, Synax shows a configuration blocked state
4. The previous session status is preserved:
   - **Ready** → ready for a new message
   - **Failed/Blocked** → shows the last blocker, ready to continue

## Session Lifecycle

- Sessions are created automatically when you start typing in the TUI
- Events are appended in real-time as the agent works
- The index is updated on every event
- Old sessions (>200) are pruned automatically

## Performance

- The resume picker reads only the metadata index (~KB), not full transcripts
- Event logs are read on-demand during resume
- Session storage is append-only JSONL for reliability
- Maximum 200 sessions retained

## Limitations (Current)

- Sessions are not synced across machines
- No semantic search over session history
- Session export/import is planned
