-- Indexes the scale test showed a need for (scripts/scale-test.ts, packages/modules/test/scale).
-- Each is here because EXPLAIN showed the statement named reading the whole table without it.

-- runDueJobs (packages/core/src/jobs.ts) starts every claim by putting back jobs whose worker
-- stopped: `update jobs ... where status = 'running' and locked_at < $1`. With only
-- jobs_due (queued) and jobs_org behind it, that was a sequential scan of the whole queue
-- table, history included, on every claim by every worker. Running jobs are a handful of rows.
create index jobs_running on jobs (locked_at) where status = 'running';

-- deadJobSummary (the platform's tenant-health view, and the ops_watch agent for one org every
-- quarter hour): `where status = 'dead' [and org_id in (...)] group by org_id`. Without this it
-- read every job the org ever ran (jobs_org), or the whole table when no org was named.
create index jobs_dead on jobs (org_id, finished_at) where status = 'dead';

select app.apply_tenant_rls();
