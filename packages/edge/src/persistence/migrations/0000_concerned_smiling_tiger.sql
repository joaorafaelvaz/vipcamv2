CREATE TABLE "cameras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"ip_address" text NOT NULL,
	"credentials_ref" text DEFAULT 'CAMERA' NOT NULL,
	"face_db_capacity" integer DEFAULT 10000 NOT NULL,
	"face_db_used" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
