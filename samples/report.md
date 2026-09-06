# Comparison

PostgreSQL provides relational constraints, joins and ACID transactions [PG]. MongoDB offers flexible documents and sharding, with care needed for relationships [MONGO]. SQLite is embedded, supports SQL and transactions, and avoids a separate database server [SQLITE].

# Tradeoffs

PostgreSQL needs planning for horizontal write scaling. MongoDB transactions add complexity, and billing relationships require careful modeling. SQLite's single writer and local file deployment constrain a distributed service. All three can store data, but their operational and modeling tradeoffs differ. The supplied notes do not provide pricing or performance measurements, so an exact cost or throughput comparison is not supported.

# Recommendation

Choose managed PostgreSQL for the small team's transactional SaaS application. Relational billing benefits from constraints and joins. Managed hosting reduces operations work within the team's limited operations budget, while write scaling can be planned as traffic grows. This recommendation follows the workload fit rather than an unsupported claim about benchmark performance or a guaranteed hosting price.
