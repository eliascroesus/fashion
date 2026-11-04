CREATE TYPE "public"."look_style" AS ENUM('minimal', 'streetwear', 'classic', 'sporty', 'romantic', 'edgy', 'colorful');--> statement-breakpoint
ALTER TABLE "feed_snapshots" ADD COLUMN "taste_key" text;--> statement-breakpoint
ALTER TABLE "looks" ADD COLUMN "style_tags" "look_style"[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX "looks_feed_style_idx" ON "looks" USING gin ("style_tags") WHERE "looks"."status" = 'published' and "looks"."deleted_at" is null;