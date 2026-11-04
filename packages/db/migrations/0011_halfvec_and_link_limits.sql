-- Step 3.1 review: fingerprints as half-precision numbers (halfvec: half the disk and HNSW index
-- memory; cosine ranking is the same in practice), indexes on the two photo links so deleting a
-- photo doesn't read every look item and product, and a 2 KB cap on offer links (the unique index
-- on offers.url can't hold much more). The tables are still empty when this runs.
DROP INDEX "garments_embedding_idx";--> statement-breakpoint
DROP INDEX "products_embedding_idx";--> statement-breakpoint
ALTER TABLE "garments" ALTER COLUMN "embedding" SET DATA TYPE extensions.halfvec(768) USING "embedding"::extensions.halfvec(768);--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "embedding" SET DATA TYPE extensions.halfvec(768) USING "embedding"::extensions.halfvec(768);--> statement-breakpoint
CREATE INDEX "look_items_media_id_idx" ON "look_items" USING btree ("media_id") WHERE "look_items"."media_id" is not null;--> statement-breakpoint
CREATE INDEX "products_image_media_id_idx" ON "products" USING btree ("image_media_id") WHERE "products"."image_media_id" is not null;--> statement-breakpoint
CREATE INDEX "garments_embedding_idx" ON "garments" USING hnsw ("embedding" extensions.halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "products_embedding_idx" ON "products" USING hnsw ("embedding" extensions.halfvec_cosine_ops);--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_url_length" CHECK (octet_length("offers"."url") <= 2048 and octet_length("offers"."page_url") <= 2048);