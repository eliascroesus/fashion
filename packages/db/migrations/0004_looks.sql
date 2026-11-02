CREATE TYPE "public"."client_platform" AS ENUM('ios', 'android', 'web');--> statement-breakpoint
CREATE TYPE "public"."look_occasion" AS ENUM('everyday', 'work', 'date', 'party', 'wedding', 'travel', 'sport', 'festival');--> statement-breakpoint
CREATE TYPE "public"."look_season" AS ENUM('spring', 'summer', 'autumn', 'winter');--> statement-breakpoint
CREATE TYPE "public"."look_status" AS ENUM('draft', 'pending', 'published', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."swipe_kind" AS ENUM('skip', 'see_less');--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"profile_id" uuid,
	"session_id" uuid,
	"look_id" uuid,
	"position" integer,
	"source" text,
	"platform" "client_platform",
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "events_pkey" PRIMARY KEY("created_at","id"),
	CONSTRAINT "events_name_format" CHECK ("events"."name" ~ '^[a-z_]{1,40}$')
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Added by hand (drizzle-kit can't express partitions): one partition per month is
-- created ahead by the API (ensureEventPartitions). This catch-all only fills up if
-- that job stops running, so no event is ever refused.
CREATE TABLE "events_default" PARTITION OF "events" DEFAULT;--> statement-breakpoint
ALTER TABLE "events_default" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "look_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"look_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	CONSTRAINT "look_media_position_range" CHECK ("look_media"."position" between 0 and 9)
);
--> statement-breakpoint
ALTER TABLE "look_media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "looks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"author_profile_id" uuid NOT NULL,
	"caption" text,
	"status" "look_status" DEFAULT 'draft' NOT NULL,
	"slug" text NOT NULL,
	"occasion_tags" "look_occasion"[] DEFAULT '{}' NOT NULL,
	"season_tags" "look_season"[] DEFAULT '{}' NOT NULL,
	"ai_description" text,
	"popularity_score" double precision DEFAULT 0 NOT NULL,
	"is_sponsored" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "looks_published_has_time" CHECK ("looks"."status" <> 'published' or "looks"."published_at" is not null),
	CONSTRAINT "looks_slug_format" CHECK ("looks"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "looks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "board_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"board_id" uuid NOT NULL,
	"look_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "board_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "boards_name_length" CHECK (char_length("boards"."name") between 1 and 50)
);
--> statement-breakpoint
ALTER TABLE "boards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"follower_profile_id" uuid NOT NULL,
	"followed_profile_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "follows_not_self" CHECK ("follows"."follower_profile_id" <> "follows"."followed_profile_id")
);
--> statement-breakpoint
ALTER TABLE "follows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "saves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"profile_id" uuid NOT NULL,
	"look_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "saves" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "seen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"profile_id" uuid NOT NULL,
	"look_id" uuid NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seen" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "swipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"profile_id" uuid NOT NULL,
	"look_id" uuid NOT NULL,
	"kind" "swipe_kind" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "swipes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "taste_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"profile_id" uuid NOT NULL,
	"styles" text[] DEFAULT '{}'::text[] NOT NULL,
	"brands" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "taste_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "look_media" ADD CONSTRAINT "look_media_look_id_looks_id_fk" FOREIGN KEY ("look_id") REFERENCES "public"."looks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "look_media" ADD CONSTRAINT "look_media_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "looks" ADD CONSTRAINT "looks_author_profile_id_profiles_id_fk" FOREIGN KEY ("author_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_items" ADD CONSTRAINT "board_items_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_items" ADD CONSTRAINT "board_items_look_id_looks_id_fk" FOREIGN KEY ("look_id") REFERENCES "public"."looks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_profile_id_profiles_id_fk" FOREIGN KEY ("follower_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followed_profile_id_profiles_id_fk" FOREIGN KEY ("followed_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saves" ADD CONSTRAINT "saves_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saves" ADD CONSTRAINT "saves_look_id_looks_id_fk" FOREIGN KEY ("look_id") REFERENCES "public"."looks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seen" ADD CONSTRAINT "seen_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seen" ADD CONSTRAINT "seen_look_id_looks_id_fk" FOREIGN KEY ("look_id") REFERENCES "public"."looks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swipes" ADD CONSTRAINT "swipes_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swipes" ADD CONSTRAINT "swipes_look_id_looks_id_fk" FOREIGN KEY ("look_id") REFERENCES "public"."looks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taste_profiles" ADD CONSTRAINT "taste_profiles_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "look_media_look_position_key" ON "look_media" USING btree ("look_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "look_media_look_media_key" ON "look_media" USING btree ("look_id","media_id");--> statement-breakpoint
CREATE INDEX "look_media_media_id_idx" ON "look_media" USING btree ("media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "looks_slug_key" ON "looks" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "looks_author_profile_id_idx" ON "looks" USING btree ("author_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "board_items_board_look_key" ON "board_items" USING btree ("board_id","look_id");--> statement-breakpoint
CREATE INDEX "board_items_look_id_idx" ON "board_items" USING btree ("look_id");--> statement-breakpoint
CREATE INDEX "boards_profile_id_idx" ON "boards" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "follows_follower_followed_key" ON "follows" USING btree ("follower_profile_id","followed_profile_id");--> statement-breakpoint
CREATE INDEX "follows_followed_profile_id_idx" ON "follows" USING btree ("followed_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saves_profile_look_key" ON "saves" USING btree ("profile_id","look_id");--> statement-breakpoint
CREATE INDEX "saves_look_id_idx" ON "saves" USING btree ("look_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seen_profile_look_key" ON "seen" USING btree ("profile_id","look_id");--> statement-breakpoint
CREATE INDEX "seen_profile_last_seen_idx" ON "seen" USING btree ("profile_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "swipes_profile_look_key" ON "swipes" USING btree ("profile_id","look_id");--> statement-breakpoint
CREATE UNIQUE INDEX "taste_profiles_profile_id_key" ON "taste_profiles" USING btree ("profile_id");