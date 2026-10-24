-- One POS 0043: the company check of row-level security may run in Postgres' parallel workers (it only reads the request's
-- app.company_id setting, which workers inherit). Not marked, it kept every report to one CPU core.
ALTER FUNCTION app_company_id() PARALLEL SAFE;
