-- One POS 0074: a closed day's CASH section, recalculated till by till (as Days.DayCashAsync does from now on). Shifts on one till follow
-- each other in the same drawer, so the next shift's float is the cash the last one counted, not more money: adding every shift's float
-- counted that cash twice (e.g. 25-10-2026 Till1: Gladys counted 1,775.25, Cham opened with that 1,775.25).
-- Per till: the first shift's float; taken out / put in between shifts = the last count (or expected, if not counted) less the next
-- float; the drawer ends on the last shift's expected, against the last shift's count. Only the "cash" part of closed days' kept Z
-- reports changes; sales, payments and the shifts' own figures stay as they were.
WITH s AS (
  SELECT x.business_day_id, x.opening_float, x.expected_cash, x.counted_cash,
         row_number() OVER w AS rn, count(*) OVER (PARTITION BY x.business_day_id, x.register_id) AS cnt,
         lag(coalesce(x.counted_cash, x.expected_cash)) OVER w AS prev_end
  FROM shift x
  WINDOW w AS (PARTITION BY x.business_day_id, x.register_id ORDER BY x.opened_at)
), per_day AS (
  SELECT business_day_id,
         coalesce(sum(opening_float) FILTER (WHERE rn = 1), 0) AS opening_float,
         coalesce(sum(prev_end - opening_float) FILTER (WHERE rn > 1), 0) AS shift_change,
         coalesce(sum(expected_cash) FILTER (WHERE rn = cnt), 0) AS expected,
         coalesce(sum(counted_cash) FILTER (WHERE rn = cnt), 0) AS counted,
         count(*) FILTER (WHERE rn = cnt AND counted_cash IS NULL)::int AS uncounted
  FROM s GROUP BY business_day_id
)
UPDATE business_day bd
SET z_report = bd.z_report || jsonb_build_object('cash', (bd.z_report -> 'cash') || jsonb_build_object(
  'openingFloat', p.opening_float, 'shiftChange', p.shift_change, 'expected', p.expected, 'counted', p.counted, 'uncounted', p.uncounted))
FROM per_day p
WHERE p.business_day_id = bd.id AND bd.status = 'closed' AND bd.z_report ? 'cash';
