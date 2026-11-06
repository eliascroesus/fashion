-- Step 3.5, the automatic link check: a look item can wait for a person (status 'review', with a
-- 'link_check' item in moderation_queue), the check's AI calls are logged like spotting's, and its
-- score thresholds live in the new settings table (not in code), starting from the provisional
-- defaults inserted below (docs/PROGRESS.md, "Measured numbers"). The new enum values aren't used
-- in this file: Postgres only allows that once the migration has committed.
ALTER TYPE "public"."ai_call_purpose" ADD VALUE 'link_check';--> statement-breakpoint
ALTER TYPE "public"."moderation_kind" ADD VALUE 'link_check';--> statement-breakpoint
ALTER TYPE "public"."look_item_status" ADD VALUE 'review';--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	CONSTRAINT "settings_key_format" CHECK ("settings"."key" ~ '^[a-z0-9_]+$')
);
--> statement-breakpoint
ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "moderation_queue" ADD COLUMN "look_item_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "settings_key_key" ON "settings" USING btree ("key");--> statement-breakpoint
ALTER TABLE "moderation_queue" ADD CONSTRAINT "moderation_queue_look_item_id_look_items_id_fk" FOREIGN KEY ("look_item_id") REFERENCES "public"."look_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_queue_open_look_item_key" ON "moderation_queue" USING btree ("kind","look_item_id") WHERE "moderation_queue"."status" = 'open';--> statement-breakpoint
CREATE INDEX "moderation_queue_look_item_id_idx" ON "moderation_queue" USING btree ("look_item_id") WHERE "moderation_queue"."look_item_id" is not null;--> statement-breakpoint
ALTER TABLE "moderation_queue" ADD CONSTRAINT "moderation_queue_has_subject" CHECK ("moderation_queue"."media_id" is not null or "moderation_queue"."look_item_id" is not null);--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "description") VALUES (
	'link_check_thresholds',
	'{"verifyAt": 0.85, "rejectBelow": 0.6}',
	'Link check (Step 3.5): a garment and product photo at least verifyAt alike are verified; below rejectBelow rejected; in between the AI is asked. Cosine similarity of their fingerprints.'
);
