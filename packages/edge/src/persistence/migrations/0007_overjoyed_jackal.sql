CREATE TABLE "person_merge_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"src_id" uuid NOT NULL,
	"dst_id" uuid NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merged_by" text NOT NULL,
	"src_snapshot" jsonb NOT NULL
);
