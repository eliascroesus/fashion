-- Step 3.3, garment spotting: a log of every paid AI call (the daily spend cap adds it up), the
-- review queue for photos the AI flags, each photo's AI reading (sentence, search words, safety
-- flags) and whole-photo fingerprint, and which model made each fingerprint.
-- Search also reads the looks' AI search words: a new look_search_vector with an ai_tags argument
-- replaces the 0009 one, and the generated column switches to it in place (SET EXPRESSION,
-- Postgres 17), which keeps looks_search_idx (rebuilt). Written by hand: drizzle-kit would drop
-- and re-add the column. Extension types are schema-qualified (see packages/db/README.md).
CREATE TYPE "public"."ai_call_purpose" AS ENUM('spot_garments');--> statement-breakpoint
CREATE TYPE "public"."ai_call_status" AS ENUM('ok', 'blocked', 'invalid', 'failed');--> statement-breakpoint
CREATE TYPE "public"."media_spot_status" AS ENUM('done', 'flagged', 'failed');--> statement-breakpoint
CREATE TYPE "public"."safety_flag" AS ENUM('nudity', 'violence', 'spam_text', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."moderation_kind" AS ENUM('photo_flagged');--> statement-breakpoint
CREATE TYPE "public"."moderation_status" AS ENUM('open', 'approved', 'removed');--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" "ai_call_purpose" NOT NULL,
	"model" text NOT NULL,
	"model_version" text,
	"prompt_version" text NOT NULL,
	"status" "ai_call_status" NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"thinking_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer NOT NULL,
	"http_status" integer,
	"error" text,
	"media_id" uuid,
	"look_id" uuid,
	CONSTRAINT "ai_calls_counts_not_negative" CHECK ("ai_calls"."input_tokens" >= 0 and "ai_calls"."output_tokens" >= 0 and "ai_calls"."thinking_tokens" >= 0 and "ai_calls"."cost_micros" >= 0 and "ai_calls"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "moderation_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "moderation_kind" NOT NULL,
	"media_id" uuid,
	"reasons" "safety_flag"[] DEFAULT '{}' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "moderation_status" DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "moderation_queue_details_is_object" CHECK (jsonb_typeof("moderation_queue"."details") = 'object'),
	CONSTRAINT "moderation_queue_resolved_has_time" CHECK (("moderation_queue"."status" = 'open') = ("moderation_queue"."resolved_at" is null))
);
--> statement-breakpoint
ALTER TABLE "moderation_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "looks" ADD COLUMN "ai_tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE FUNCTION public.look_search_vector(
  caption text,
  ai_description text,
  ai_tags text[],
  occasion_tags public.look_occasion[],
  season_tags public.look_season[],
  style_tags public.look_style[]
) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN setweight(to_tsvector('pg_catalog.simple'::regconfig, concat_ws(' ',
           array_to_string(occasion_tags::text[], ' '),
           array_to_string(season_tags::text[], ' '),
           array_to_string(style_tags::text[], ' '),
           caption)), 'A')
    || setweight(to_tsvector('pg_catalog.simple'::regconfig, concat_ws(' ',
           ai_description,
           array_to_string(ai_tags, ' '))), 'B');--> statement-breakpoint
ALTER TABLE "looks" ALTER COLUMN "search_vector" SET EXPRESSION AS (look_search_vector(caption, ai_description, ai_tags, occasion_tags, season_tags, style_tags));--> statement-breakpoint
DROP FUNCTION public.look_search_vector(text, text, public.look_occasion[], public.look_season[], public.look_style[]);--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "spot_status" "media_spot_status";--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "spotted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "ai_description" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "ai_tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "safety_flags" "safety_flag"[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "embedding" extensions.halfvec(768);--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "garments" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "moderation_queue" ADD CONSTRAINT "moderation_queue_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_created_at_idx" ON "ai_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_calls_media_id_idx" ON "ai_calls" USING btree ("media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_queue_open_media_key" ON "moderation_queue" USING btree ("kind","media_id") WHERE "moderation_queue"."status" = 'open';--> statement-breakpoint
CREATE INDEX "moderation_queue_open_idx" ON "moderation_queue" USING btree ("created_at") WHERE "moderation_queue"."status" = 'open';--> statement-breakpoint
CREATE INDEX "media_embedding_idx" ON "media" USING hnsw ("embedding" extensions.halfvec_cosine_ops);