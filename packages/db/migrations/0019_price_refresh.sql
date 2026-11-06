-- Step 3.9, the price and stock check: each offer keeps the record of its last check (tried
-- when, what it found, failures and "page gone" results in a row, not before when), runs are
-- logged (the daily caps count their page reads), shops that turned us away rest a while, and
-- every link to one shop page is found together (offers_page_url_idx). Caps and timings live in
-- the settings row inserted at the end (docs/PROGRESS.md, Step 3.9).
CREATE TABLE "price_refresh_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"reads_saved_or_popular" integer DEFAULT 0 NOT NULL,
	"reads_others" integer DEFAULT 0 NOT NULL,
	"found" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "price_refresh_runs_reads_not_negative" CHECK ("price_refresh_runs"."reads_saved_or_popular" >= 0 and "price_refresh_runs"."reads_others" >= 0),
	CONSTRAINT "price_refresh_runs_found_is_object" CHECK (jsonb_typeof("price_refresh_runs"."found") = 'object')
);
--> statement-breakpoint
ALTER TABLE "price_refresh_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "price_refresh_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"site" text NOT NULL,
	"rest_until" timestamp with time zone NOT NULL,
	"last_problem" text NOT NULL,
	"strikes" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "price_refresh_sites_strikes_positive" CHECK ("price_refresh_sites"."strikes" >= 1)
);
--> statement-breakpoint
ALTER TABLE "price_refresh_sites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "refresh_tried_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "refresh_outcome" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "refresh_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "refresh_gone" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "refresh_due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "price_refresh_runs_created_at_idx" ON "price_refresh_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "price_refresh_sites_site_key" ON "price_refresh_sites" USING btree ("site");--> statement-breakpoint
CREATE INDEX "offers_page_url_idx" ON "offers" USING btree ("page_url") WHERE "offers"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_refresh_outcome_known" CHECK ("offers"."refresh_outcome" in ('ok', 'moved', 'gone', 'blocked', 'failed', 'unreadable'));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_refresh_counts" CHECK ("offers"."refresh_failures" >= 0 and "offers"."refresh_gone" >= 0);
--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "description") VALUES (
	'price_refresh',
	'{"savedOrPopularPerDay": 1000, "othersPerDay": 500, "popularLooks": 200, "maxPerRun": 30, "siteGapMs": 2000, "goneAfter": 3}',
	'Price and stock check (Step 3.9): shop pages read per UTC day for saved or popular looks (daily) and for the rest (weekly); the most popular looks that count as popular; most pages per 10-minute run; ms between two reads of one shop; checks in a row a page must be gone before its offers count as sold out.'
);
