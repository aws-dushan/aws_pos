# One POS — technical documentation

By Dushan Fernando

For developers and IT staff who build, run or support One POS. The user manual (all roles, by task) is a separate
document: [docs/manual/user-manual.md](manual/user-manual.md), printed as its own PDF.

| # | Document | What it covers |
| --- | --- | --- |
| 1 | [Architecture](01-architecture.md) | The parts, how a sale flows through them, background jobs, security |
| 2 | [Development](02-development.md) | Repository layout, conventions, adding a database change or a screen |
| 3 | [Database](03-database.md) | PostgreSQL, row-level security, main tables, numbering, posting queue |
| 4 | [FACTS integration](04-facts-integration.md) | What is read from FACTS, what is posted, document types, procedures, rehearsals |
| 5 | [Till devices](05-device-service.md) | Device Service, tray app, printing, cash drawer, updates |
| 6 | [Servers and releases](06-servers-and-releases.md) | The live system, releasing, rollback, backups, access |
| 7 | [Operations and support](07-operations.md) | Health checks, logs, common support jobs, what never to do |
| R | [API reference](reference/api.md) | Generated from the code |
