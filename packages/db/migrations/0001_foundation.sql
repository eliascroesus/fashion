CREATE TYPE "public"."media_status" AS ENUM('pending', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'editor');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('personal', 'creator', 'business');--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_profile_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "feature_flags_key_format" CHECK ("feature_flags"."key" ~ '^[a-z0-9_]+$')
);
--> statement-breakpoint
ALTER TABLE "feature_flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_profile_id" uuid NOT NULL,
	"status" "media_status" DEFAULT 'pending' NOT NULL,
	"original_key" text NOT NULL,
	"content_type" text,
	"byte_size" integer,
	"key_1080" text,
	"key_600" text,
	"key_300" text,
	"width" integer,
	"height" integer,
	"thumbhash" text,
	"dominant_color" text,
	"error" text,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "media_ready_is_complete" CHECK ("media"."status" <> 'ready' or ("media"."key_1080" is not null and "media"."key_600" is not null and "media"."key_300" is not null and "media"."width" > 0 and "media"."height" > 0 and "media"."thumbhash" is not null and "media"."dominant_color" is not null)),
	CONSTRAINT "media_dominant_color_format" CHECK ("media"."dominant_color" ~ '^#[0-9a-f]{6}$')
);
--> statement-breakpoint
ALTER TABLE "media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profile_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'owner' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"avatar_media_id" uuid,
	"account_type" "account_type" DEFAULT 'personal' NOT NULL,
	"creator_category" text,
	"brand_name" text,
	"logo_media_id" uuid,
	"website_url" text,
	"is_verified" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "profiles_handle_format" CHECK ("profiles"."handle" ~ '^[a-z0-9._]{3,30}$')
);
--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_owner_profile_id_profiles_id_fk" FOREIGN KEY ("owner_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_members" ADD CONSTRAINT "profile_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_members" ADD CONSTRAINT "profile_members_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_avatar_media_id_media_id_fk" FOREIGN KEY ("avatar_media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_logo_media_id_media_id_fk" FOREIGN KEY ("logo_media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "media_original_key_key" ON "media" USING btree ("original_key");--> statement-breakpoint
CREATE INDEX "media_owner_profile_id_idx" ON "media" USING btree ("owner_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_members_user_profile_key" ON "profile_members" USING btree ("user_id","profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_members_one_active_per_user" ON "profile_members" USING btree ("user_id") WHERE "profile_members"."is_active";--> statement-breakpoint
CREATE INDEX "profile_members_profile_id_idx" ON "profile_members" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_handle_key" ON "profiles" USING btree ("handle");