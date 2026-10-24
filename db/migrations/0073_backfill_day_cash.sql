-- One POS 0073: the CASH section for days closed before it existed. A closed day's Z report is kept as it was printed; this only ADDS
-- its "cash" part (the same as Days.DayReportAsync builds), worked out from the day's shifts: floats + cash sales - cash refunds +
-- cash in - cash out - safe drops - bank deposits from drawers, against what was counted, with every cash movement and its reason.
-- Every other figure in those reports stays as it was. Days that already have it are left alone, so it changes nothing if run again.
WITH day_cash AS (
  SELECT bd.id,
    coalesce((SELECT sum(s.opening_float) FROM shift s WHERE s.business_day_id = bd.id), 0) AS float,
    coalesce((SELECT sum(p.amount) FROM payment p JOIN shift x ON x.id = p.shift_id WHERE x.business_day_id = bd.id AND p.method = 'cash' AND p.kind = 'payment'), 0) AS sales,
    coalesce((SELECT sum(p.amount) FROM payment p JOIN shift x ON x.id = p.shift_id WHERE x.business_day_id = bd.id AND p.method = 'cash' AND p.kind = 'refund'), 0) AS refunds,
    coalesce((SELECT sum(m.amount) FROM cash_movement m JOIN shift x ON x.id = m.shift_id WHERE x.business_day_id = bd.id AND m.kind = 'in'), 0) AS cash_in,
    coalesce((SELECT sum(m.amount) FROM cash_movement m JOIN shift x ON x.id = m.shift_id WHERE x.business_day_id = bd.id AND m.kind = 'out'), 0) AS cash_out,
    coalesce((SELECT sum(m.amount) FROM cash_movement m JOIN shift x ON x.id = m.shift_id WHERE x.business_day_id = bd.id AND m.kind = 'drop'), 0) AS drops,
    coalesce((SELECT sum(m.amount) FROM cash_movement m JOIN shift x ON x.id = m.shift_id WHERE x.business_day_id = bd.id AND m.kind = 'deposit'), 0) AS deposits,
    coalesce((SELECT sum(s.counted_cash) FROM shift s WHERE s.business_day_id = bd.id), 0) AS counted,
    (SELECT count(*) FROM shift s WHERE s.business_day_id = bd.id AND s.counted_cash IS NULL)::int AS uncounted,
    coalesce((SELECT jsonb_agg(jsonb_build_object('kind', m.kind, 'amount', m.amount, 'reason', m.reason, 'register', r.name, 'by', u.display_name, 'at', m.at) ORDER BY m.at)
              FROM cash_movement m JOIN shift x ON x.id = m.shift_id LEFT JOIN register r ON r.id = x.register_id LEFT JOIN app_user u ON u.id = m.by_user
              WHERE x.business_day_id = bd.id), '[]'::jsonb) AS movements
  FROM business_day bd
  WHERE bd.status = 'closed' AND bd.z_report IS NOT NULL AND NOT (bd.z_report ? 'cash')
)
UPDATE business_day bd
SET z_report = bd.z_report || jsonb_build_object('cash', jsonb_build_object(
  'openingFloat', dc.float, 'cashSales', dc.sales, 'cashRefunds', dc.refunds, 'cashIn', dc.cash_in, 'cashOut', dc.cash_out, 'drops', dc.drops, 'deposits', dc.deposits,
  'expected', dc.float + dc.sales - dc.refunds + dc.cash_in - dc.cash_out - dc.drops - dc.deposits,
  'counted', dc.counted, 'uncounted', dc.uncounted, 'movements', dc.movements))
FROM day_cash dc
WHERE dc.id = bd.id;
