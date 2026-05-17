# Super Security

Super must be conservative by default.

- Do not auto-apply `self.md` or `world.md` patches unless explicitly enabled.
- Do not browse, message, submit, apply, scrape, or automate accounts without
  explicit user consent and visible controls.
- LinkedIn and browser integrations must be transparent, user-consented,
  rate-limited, and non-evasive.
- Do not add stealth, anti-detection, or ToS-abusive behavior.
- Redact secrets before logs.
- Keep inbound dedupe and per-conversation reply fences enabled.
- Use a session write lock for daemon runs.
- Prefer auditable inbox/outbox/world artifacts over hidden state mutation.
