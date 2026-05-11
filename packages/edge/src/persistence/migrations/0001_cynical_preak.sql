CREATE TYPE "public"."person_type" AS ENUM('client', 'employee', 'anonymous');--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"person_type" "person_type" DEFAULT 'anonymous' NOT NULL,
	"erp_client_id" text,
	"erp_employee_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_visits" integer DEFAULT 1 NOT NULL,
	"avg_satisfaction" real,
	"estimated_age" integer,
	"estimated_gender" text,
	"thumbnail_path" text,
	"notes" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "face_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"camera_face_id" text,
	"embedding" vector(512),
	"snapshot_path" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "face_records" ADD CONSTRAINT "face_records_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "persons_erp_client_idx" ON "persons" USING btree ("erp_client_id");--> statement-breakpoint
CREATE INDEX "persons_erp_employee_idx" ON "persons" USING btree ("erp_employee_id");--> statement-breakpoint
CREATE INDEX "persons_last_seen_idx" ON "persons" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "face_records_person_idx" ON "face_records" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "face_records_camera_face_idx" ON "face_records" USING btree ("camera_face_id");--> statement-breakpoint
CREATE INDEX "face_records_embedding_hnsw_idx" ON "face_records" USING hnsw (embedding vector_cosine_ops) WITH (m=16,ef_construction=64);