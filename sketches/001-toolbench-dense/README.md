## Variant: Toolbench (dense power-user)

### Design stance
Respects that the real product is a pipeline (search → grab → unpack → register) — so the UI is a cockpit: lists, statuses, queues, no ceremony.

### Key choices
- Layout: command bar + 3 panes (nav / table / detail) + always-visible download dock
- Typography: Inter + JetBrains Mono for every number that matters
- Color: graphite with rust-orange accent; statuses carry the color (green/amber/red)
- Interaction: live filtering, Ctrl+K focus, row selection updates recipe pane, pause/resume on live simulating downloads

### Trade-offs
- Strong at: throughput and transparency — you SEE the agent recipe executing; server-operator ergonomics
- Weak at: zero romance; wouldn't impress a friend browsing casually

### Best for
You, daily — and for friends on lower-end PCs/laptops where density wins.
