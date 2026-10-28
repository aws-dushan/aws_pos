-- One POS 0083: wastage waiting for FACTS holds back only the stock that was there before it was recorded, never what arrived after.
-- The FACTS stock read (every 5 minutes) also reads what arrived at the branch's location (posted deliveries) since the item's
-- oldest wastage still waiting; what FACTS has beyond that is the old stock the wastage can hold back. E.g. 1 expired piece
-- waiting for approval, FACTS shows 1 and 1 arrived today: the expired one is already out of FACTS, today's one sells.
ALTER TABLE branch_item ADD COLUMN erp_in_since_waste numeric(14,3) NULL;  -- null: no wastage waiting at the last read

-- What a branch's wastage takes off an item's FACTS stock (as last read, at p_at, with p_in arrived since the oldest waiting wastage):
-- wastage posted in FACTS after the read in full; wastage still waiting up to the old stock.
CREATE FUNCTION wastage_held(p_branch uuid, p_item uuid, p_stock numeric, p_at timestamptz, p_in numeric) RETURNS numeric
LANGUAGE sql STABLE AS $$
  select coalesce((select sum(w.qty) from wastage w where w.item_id = p_item and w.branch_id = p_branch and w.voided_at is null
                     and w.erp_status = 'posted' and w.erp_matched_at > p_at), 0)
       + least(coalesce((select sum(w.qty) from wastage w where w.item_id = p_item and w.branch_id = p_branch and w.voided_at is null
                           and w.erp_status not in ('none', 'posted')), 0),
               greatest(0, p_stock - coalesce(p_in, 0)))
$$;
