-- One POS 0071: recording a bank deposit is its own right (day.deposit), so cashiers can record the cash they take to the bank
-- (amount, bag number, who takes it) without the right to open and close the day. Every existing role that runs shifts or the day
-- gets it; a company can take it off a role again in Roles.
UPDATE role SET permissions = array_append(permissions, 'day.deposit')
WHERE ('day.shift' = ANY (permissions) OR 'day.manage' = ANY (permissions)) AND NOT ('day.deposit' = ANY (permissions));
