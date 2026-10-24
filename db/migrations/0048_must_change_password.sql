-- One POS 0048: a password someone else set (the first administrator on a new server, a password an administrator gives a user) must be
-- changed by its owner at the first sign-in; until then that session can do nothing but change it.
ALTER TABLE app_user ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
