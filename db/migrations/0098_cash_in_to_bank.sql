-- One POS 0098: a Cash in with the reason "Cash to deposit to bank" puts the cash in the drawer and adds it to what the branch owes
-- the bank (Cash to bank), with the cashier's note as the remark. The amount owed keeps the cash movement it came from.
ALTER TABLE cash_bank_adjustment ADD COLUMN cash_movement_id uuid NULL REFERENCES cash_movement;
GRANT INSERT ON cash_bank_adjustment TO onepos_app;
