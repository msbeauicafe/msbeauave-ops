-- MS BEAU AVE — GCash's box sits under BANK on Cash position
--
-- Bank report → Bank → Cash position lays its boxes out by the side each
-- account is set to (db/188). GCash was set beside Cash on hand; the owner
-- wants it under BANK, after Security Bank — its place on the list (4) already
-- puts it there. Only that box moves: nothing else reads the side.

update bank_txn_accounts set cash_column = 'bank' where 'GCASH' = any(aliases);

select name, cash_column, place from bank_txn_accounts order by place nulls last, id;
