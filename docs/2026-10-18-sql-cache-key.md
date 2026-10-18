# Translation cache key hardening

The PostgreSQL translator is the measured API CPU hotspot. Reuse the bounded
translation cache, keeping parameter values out of its keys and entries. Encode
the dialect, exact SQL text and parameter shape as a structured JSON tuple;
delimiter characters in names or text must never alias another statement.
Positional arrays depend only on whether they are empty. Preserve named-key
order, because the scanner uses that order to resolve equal-length matches.

Validate a finite nonnegative integer entry bound when constructing the cache
and whenever dynamic configuration changes. Zero disables and clears it; a
smaller bound evicts immediately, including on hits. Invalid configuration fails
clearly instead of creating an unbounded cache. Translation failures are not
cached; parameter values and query results are never retained. Each caller gets
its own SQL/result metadata copy.

Adversarial tests cover delimiter collisions, separate SQL and dialects, changed
values, invalid bounds and shrinking on hits. The existing corpus comparison and
live PostgreSQL query test prove unchanged translations and fresh values. MySQL
has no translator cache and keeps its existing behavior. Database outages follow
the existing connection/error/retry paths; caching stores no database state and
does not change their detection, UI, retained work or recovery.
