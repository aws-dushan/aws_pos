-- One POS 0046: the company check of row-level security worked out once per query instead of once per row. Written as
-- "company_id = app_company_id()" Postgres re-reads the setting for every row it looks at (a year's report: ~110k times);
-- as "(select app_company_id())" it is one value for the whole query. The rule itself is unchanged.
DO $$ DECLARE p record; BEGIN
  FOR p IN SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', p.policyname, p.schemaname, p.tablename,
      replace(p.qual, 'app_company_id()', '(SELECT app_company_id())'));
    IF p.with_check IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)', p.policyname, p.schemaname, p.tablename,
        replace(p.with_check, 'app_company_id()', '(SELECT app_company_id())'));
    END IF;
  END LOOP;
END $$;
