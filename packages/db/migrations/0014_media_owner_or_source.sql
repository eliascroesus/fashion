-- Step 3.4 review: every photo is either someone's upload (an owner) or a shop's product photo
-- copied in from a link (its source link). Nothing else may be ownerless.
ALTER TABLE "media" ADD CONSTRAINT "media_owner_or_source" CHECK ("media"."owner_profile_id" is not null or "media"."source_url" is not null);
