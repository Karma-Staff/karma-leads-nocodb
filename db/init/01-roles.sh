#!/bin/sh
# Runs ONCE, on first boot of an empty pgdata volume (postgres image behavior).
# Creates the databases and the two working roles:
#
#   karma_api     — the domain API. Owns the `karma` database and its schema;
#                   the ONLY role that runs DDL, and only via migrations.
#   nocodb_admin  — the NocoDB admin container. Owns `nocodb_meta` (NocoDB
#                   needs DDL in its own metadata db) but on `karma` gets data
#                   access WITHOUT CREATE — the admin grid can edit rows, never
#                   the schema. That restriction is the enforcement of "no
#                   schema changes outside the application's migration system".
set -e

psql -v ON_ERROR_STOP=1 -U postgres <<SQL
CREATE ROLE karma_api LOGIN PASSWORD '${KARMA_API_PASSWORD}';
CREATE ROLE nocodb_admin LOGIN PASSWORD '${NOCODB_ADMIN_PASSWORD}';

CREATE DATABASE karma OWNER karma_api;
CREATE DATABASE nocodb_meta OWNER nocodb_admin;
SQL

# Inside karma: karma_api owns the public schema; nocodb_admin gets DML on
# everything karma_api will ever create there, and nothing more.
psql -v ON_ERROR_STOP=1 -U postgres -d karma <<SQL
-- extensions need superuser; migrations run as karma_api, so this lives here
CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER SCHEMA public OWNER TO karma_api;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nocodb_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE karma_api IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nocodb_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE karma_api IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nocodb_admin;
SQL
