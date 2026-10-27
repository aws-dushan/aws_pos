-- One POS 0079: requests approved together go to FACTS as one STR50 per branch and store, their lines one after another. Each request
-- line keeps its line number on that STR50, so what the store sends against it still shows per line. Null: its own line (as before).
ALTER TABLE stock_request_line ADD COLUMN str_line int NULL;
