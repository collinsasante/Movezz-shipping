-- Run ONCE per environment by a privileged operator (never by the application):
--   psql "$ADMIN_DATABASE_URL" -v migrator_password="$(read -s ...)" -v app_password="$(read -s ...)" -f db/roles/create-roles.sql
-- Passwords are supplied as psql variables so they never appear in this file, in Git or in migration history.
-- Use different passwords (and different databases) for development, staging and production.
\set ON_ERROR_STOP on
SELECT 'CREATE ROLE movezz_migrator LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD ' || quote_literal(:'migrator_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'movezz_migrator') \gexec
SELECT 'CREATE ROLE movezz_app LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD ' || quote_literal(:'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'movezz_app') \gexec
-- The migrator must be able to CREATE EXTENSION btree_gist (trusted-extension or superuser pre-install on managed hosts).
-- GRANT CREATE ON DATABASE <db> TO movezz_migrator;   -- run per database; shown here as documentation
