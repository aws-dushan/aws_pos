-- ONE POS 0116: a person's FACTS salesman (SALESMAN_MASTER code, e.g. 400219 ILIAS BOUCHTAOUI), picked on Users from FACTS' list.
-- It belongs to the person, the same in every company. A stock request they make goes to FACTS (STR50) with it as the salesman.
ALTER TABLE app_user ADD COLUMN facts_salesman text NULL;
ALTER TABLE app_user ADD COLUMN facts_salesman_name text NULL;   -- the name FACTS gave it when picked
