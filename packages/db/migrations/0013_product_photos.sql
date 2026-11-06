-- Step 3.4: a shop's product photo, copied in when a link is resolved, belongs to the product,
-- not to whoever pasted the link, so a photo may have no owner (uploads always set one), and
-- it remembers the shop's photo link so the same photo isn't copied twice.
ALTER TABLE "media" ALTER COLUMN "owner_profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "source_url" text;
