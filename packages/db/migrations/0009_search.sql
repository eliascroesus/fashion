-- What search finds in a look, as weighted words: tags and caption (A), AI description (B).
-- 'simple' means no stemming, so English and Swedish words work the same; typos are matched
-- against search_terms by the API. IMMUTABLE so the generated column below can use it: casting
-- the enum tags to text only counts as "stable" because enum labels could be renamed, and ours
-- never are (the ids are permanent, see STYLES in @outfitly/shared). The SQL-standard body is
-- bound when created, so it doesn't depend on the search_path.
CREATE FUNCTION public.look_search_vector(
  caption text,
  ai_description text,
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
    || setweight(to_tsvector('pg_catalog.simple'::regconfig, coalesce(ai_description, '')), 'B');--> statement-breakpoint
CREATE TABLE "search_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"term" text NOT NULL,
	"lexeme" text NOT NULL,
	"look_count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "looks" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (look_search_vector(caption, ai_description, occasion_tags, season_tags, style_tags)) STORED;--> statement-breakpoint
CREATE UNIQUE INDEX "search_terms_term_key" ON "search_terms" USING btree ("term");--> statement-breakpoint
CREATE INDEX "search_terms_term_trgm_idx" ON "search_terms" USING gin ("term" extensions.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "looks_search_idx" ON "looks" USING gin ("search_vector") WHERE "looks"."status" = 'published' and "looks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "profiles_handle_trgm_idx" ON "profiles" USING gin ("handle" extensions.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "profiles_display_name_trgm_idx" ON "profiles" USING gin (lower("display_name") extensions.gin_trgm_ops);