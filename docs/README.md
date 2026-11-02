# One POS — technical documentation

By Dushan Fernando

For developers and IT staff who build, run or support One POS. The user manual (all roles, by task) is a separate
document: [docs/manual/user-manual.md](manual/user-manual.md), printed as its own PDF.

| # | Document | What it covers |
| --- | --- | --- |
| 1 | [Architecture](01-architecture.md) | The parts, how a sale flows through them, background jobs, security, audit trail, money and numbers |
| 2 | [Development](02-development.md) | Repository layout, conventions, adding a database change or a screen |
| 3 | [Database](03-database.md) | PostgreSQL, row-level security, main tables, normalisation, field types and lengths, indexes and speed, numbering, posting queue |
| 4 | [FACTS integration](04-facts-integration.md) | What is read from FACTS, what is posted, document types, procedures, rehearsals |
| 5 | [Till devices](05-device-service.md) | Device Service, tray app, printing, cash drawer, updates |
| 6 | [Servers and releases](06-servers-and-releases.md) | The live system, Docker (what runs in it and why), releasing, rollback, backups, access |
| R | [API reference](reference/api.md) | Generated from the code |
| S | [Query speed](reference/query-speed.md) | The everyday queries timed on a year of sales, with the indexes each one uses. Generated |
| D | [Data dictionary](reference/data-dictionary.md) | Every table and column: type, length, null, default, keys, allowed values. Generated from the migrations |
