CREATE TABLE "feed_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"profile_id" uuid,
	"look_ids" uuid[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feed_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "feed_snapshots_created_at_idx" ON "feed_snapshots" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "looks_feed_recent_idx" ON "looks" USING btree ("published_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "looks"."status" = 'published' and "looks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "looks_feed_popular_idx" ON "looks" USING btree ("popularity_score" DESC NULLS FIRST,"published_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "looks"."status" = 'published' and "looks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "looks_feed_author_idx" ON "looks" USING btree ("author_profile_id","published_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "looks"."status" = 'published' and "looks"."deleted_at" is null;