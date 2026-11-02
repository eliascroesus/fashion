-- The app and web never read the database directly: only the API does, as the
-- table owner. Supabase grants its API roles (anon = public app key,
-- authenticated = logged-in users, service_role = secret key) full access to
-- public by default; take that away for every existing and future object.
-- Row Level Security with no policies is the second lock.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;--> statement-breakpoint
-- Future objects: cancel both schema-level and global default grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM anon, authenticated, service_role;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;--> statement-breakpoint
-- Postgres lets everyone (PUBLIC) execute new functions by default.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;
