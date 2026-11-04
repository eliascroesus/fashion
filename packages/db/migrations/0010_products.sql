-- Products and AI (Phase 3). Fingerprints are Marqo-FashionSigLIP vectors (768 numbers, its
-- open_clip_config.json "embed_dim"), compared by cosine distance through HNSW indexes. The vector
-- type and operator class are named with their schema so this never depends on the search_path.
CREATE TYPE "public"."garment_category" AS ENUM('coat', 'jacket', 'blazer', 'knitwear', 'sweatshirt', 'shirt', 't_shirt', 'top', 'dress', 'jumpsuit', 'trousers', 'jeans', 'skirt', 'shorts', 'swimwear', 'sneakers', 'boots', 'heels', 'flats', 'sandals', 'bag', 'hat', 'sunglasses', 'scarf', 'jewelry', 'watch', 'belt', 'accessory');--> statement-breakpoint
CREATE TYPE "public"."link_check_answer" AS ENUM('yes', 'no', 'unsure');--> statement-breakpoint
CREATE TYPE "public"."link_check_outcome" AS ENUM('verified', 'review', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."look_item_status" AS ENUM('pending', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."offer_stock" AS ENUM('in_stock', 'out_of_stock', 'unknown');--> statement-breakpoint
CREATE TABLE "clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"profile_id" uuid,
	"session_id" uuid,
	"look_id" uuid,
	"offer_id" uuid NOT NULL,
	"author_profile_id" uuid,
	"position" integer,
	"source" text,
	"platform" "client_platform" NOT NULL,
	CONSTRAINT "clicks_has_viewer" CHECK ("clicks"."profile_id" is not null or "clicks"."session_id" is not null),
	CONSTRAINT "clicks_position_not_negative" CHECK ("clicks"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "clicks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "garments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"media_id" uuid NOT NULL,
	"category" "garment_category" NOT NULL,
	"color" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"box_left" real NOT NULL,
	"box_top" real NOT NULL,
	"box_right" real NOT NULL,
	"box_bottom" real NOT NULL,
	"embedding" extensions.vector(768),
	"deleted_at" timestamp with time zone,
	CONSTRAINT "garments_box_inside_photo" CHECK ("garments"."box_left" >= 0 and "garments"."box_top" >= 0 and "garments"."box_right" <= 1 and "garments"."box_bottom" <= 1 and "garments"."box_left" < "garments"."box_right" and "garments"."box_top" < "garments"."box_bottom"),
	CONSTRAINT "garments_attributes_is_object" CHECK (jsonb_typeof("garments"."attributes") = 'object')
);
--> statement-breakpoint
ALTER TABLE "garments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "link_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"look_item_id" uuid NOT NULL,
	"similarity" real,
	"ai_answer" "link_check_answer",
	"outcome" "link_check_outcome" NOT NULL,
	"reason" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "link_checks_similarity_range" CHECK ("link_checks"."similarity" between -1 and 1),
	CONSTRAINT "link_checks_details_is_object" CHECK (jsonb_typeof("link_checks"."details") = 'object')
);
--> statement-breakpoint
ALTER TABLE "link_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "look_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"look_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"garment_id" uuid,
	"media_id" uuid,
	"dot_x" real,
	"dot_y" real,
	"match_score" real,
	"status" "look_item_status" DEFAULT 'pending' NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "look_items_dot_complete" CHECK (("look_items"."media_id" is null) = ("look_items"."dot_x" is null) and ("look_items"."media_id" is null) = ("look_items"."dot_y" is null)),
	CONSTRAINT "look_items_dot_inside_photo" CHECK ("look_items"."dot_x" between 0 and 1 and "look_items"."dot_y" between 0 and 1),
	CONSTRAINT "look_items_match_score_range" CHECK ("look_items"."match_score" between -1 and 1)
);
--> statement-breakpoint
ALTER TABLE "look_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"product_id" uuid NOT NULL,
	"url" text NOT NULL,
	"page_url" text NOT NULL,
	"price_minor" integer,
	"currency" text,
	"stock" "offer_stock" DEFAULT 'unknown' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"price_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "offers_url_web" CHECK ("offers"."url" ~ '^https?://' and "offers"."page_url" ~ '^https?://'),
	CONSTRAINT "offers_price_has_currency" CHECK (("offers"."price_minor" is null) = ("offers"."currency" is null)),
	CONSTRAINT "offers_price_not_negative" CHECK ("offers"."price_minor" >= 0),
	CONSTRAINT "offers_currency_format" CHECK ("offers"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "offers_price_history_is_list" CHECK (jsonb_typeof("offers"."price_history") = 'array')
);
--> statement-breakpoint
ALTER TABLE "offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"category" "garment_category",
	"gtin" text,
	"image_url" text,
	"image_media_id" uuid,
	"embedding" extensions.vector(768),
	"owner_profile_id" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "products_name_length" CHECK (char_length("products"."name") between 1 and 300),
	CONSTRAINT "products_gtin_format" CHECK ("products"."gtin" ~ '^[0-9]{8,14}$'),
	CONSTRAINT "products_image_url_web" CHECK ("products"."image_url" ~ '^https?://')
);
--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "garments" ADD CONSTRAINT "garments_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_checks" ADD CONSTRAINT "link_checks_look_item_id_look_items_id_fk" FOREIGN KEY ("look_item_id") REFERENCES "public"."look_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "look_items" ADD CONSTRAINT "look_items_look_id_looks_id_fk" FOREIGN KEY ("look_id") REFERENCES "public"."looks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "look_items" ADD CONSTRAINT "look_items_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "look_items" ADD CONSTRAINT "look_items_garment_id_garments_id_fk" FOREIGN KEY ("garment_id") REFERENCES "public"."garments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "look_items" ADD CONSTRAINT "look_items_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_image_media_id_media_id_fk" FOREIGN KEY ("image_media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_owner_profile_id_profiles_id_fk" FOREIGN KEY ("owner_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clicks_created_at_idx" ON "clicks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "garments_media_id_idx" ON "garments" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "garments_embedding_idx" ON "garments" USING hnsw ("embedding" extensions.vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "link_checks_look_item_id_idx" ON "link_checks" USING btree ("look_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "look_items_look_offer_key" ON "look_items" USING btree ("look_id","offer_id");--> statement-breakpoint
CREATE INDEX "look_items_offer_id_idx" ON "look_items" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "look_items_garment_id_idx" ON "look_items" USING btree ("garment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_url_key" ON "offers" USING btree ("url");--> statement-breakpoint
CREATE INDEX "offers_product_id_idx" ON "offers" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_gtin_key" ON "products" USING btree ("gtin") WHERE "products"."gtin" is not null;--> statement-breakpoint
CREATE INDEX "products_owner_profile_id_idx" ON "products" USING btree ("owner_profile_id");--> statement-breakpoint
CREATE INDEX "products_embedding_idx" ON "products" USING hnsw ("embedding" extensions.vector_cosine_ops);