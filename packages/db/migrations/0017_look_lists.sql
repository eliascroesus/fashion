-- Step 3.8: the ranked lists behind "More like this" and search (page 1 makes one, later pages read
-- on from it), like feed_snapshots for For You. Deleted after a day by the snapshot cleanup job.
CREATE TYPE "public"."look_list_kind" AS ENUM('similar', 'search');--> statement-breakpoint
CREATE TABLE "look_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "look_list_kind" NOT NULL,
	"key" text NOT NULL,
	"profile_id" uuid,
	"look_ids" uuid[] NOT NULL,
	"complete" boolean NOT NULL,
	CONSTRAINT "look_lists_key_length" CHECK (octet_length("look_lists"."key") BETWEEN 1 AND 400)
);
--> statement-breakpoint
ALTER TABLE "look_lists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "look_lists_created_at_idx" ON "look_lists" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "look_lists_lookup_idx" ON "look_lists" USING btree ("kind","key","profile_id","created_at");