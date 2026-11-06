-- Step 3.5 review: the link check keeps the poster's garment pick (garment_id) apart from the piece
-- it matched (matched_garment_id), knows since when an item waits (pending_since) and when it was
-- last tried (checked_at, so the hourly sweep rotates), logs which look item an AI call was about,
-- records a refused shop photo (products.image_failed_at), and refuses unknown reason codes.
-- Never name the enum values added in 0015 ('review', 'link_check') in migration SQL: on a fresh
-- database drizzle applies 0015 and later in one transaction, where Postgres refuses new values.
ALTER TABLE "ai_calls" ADD COLUMN "look_item_id" uuid;--> statement-breakpoint
ALTER TABLE "look_items" ADD COLUMN "matched_garment_id" uuid;--> statement-breakpoint
ALTER TABLE "look_items" ADD COLUMN "pending_since" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "look_items" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "image_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "look_items" ADD CONSTRAINT "look_items_matched_garment_id_garments_id_fk" FOREIGN KEY ("matched_garment_id") REFERENCES "public"."garments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_look_item_id_idx" ON "ai_calls" USING btree ("look_item_id") WHERE "ai_calls"."look_item_id" is not null;--> statement-breakpoint
CREATE INDEX "look_items_matched_garment_id_idx" ON "look_items" USING btree ("matched_garment_id");--> statement-breakpoint
CREATE INDEX "look_items_pending_idx" ON "look_items" USING btree ("checked_at") WHERE "look_items"."status" = 'pending' and "look_items"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "link_checks" ADD CONSTRAINT "link_checks_reason_known" CHECK ("link_checks"."reason" in ('sold_out', 'not_similar', 'ai_different', 'link_removed', 'ai_unsure', 'no_product_photo', 'no_garment', 'dot_not_on_piece', 'check_failed'));--> statement-breakpoint
-- Items decided before this migration: a piece the check chose isn't the poster's pick.
UPDATE "look_items" li SET "matched_garment_id" = li."garment_id", "garment_id" = NULL
 WHERE EXISTS (SELECT 1 FROM "link_checks" lc WHERE lc."look_item_id" = li."id"
                  AND lc."details"->>'garmentChoice' IN ('nearest', 'nearest in category', 'dot'));--> statement-breakpoint
UPDATE "look_items" SET "pending_since" = NULL WHERE "status" <> 'pending';
