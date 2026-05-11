CREATE TYPE "public"."match_decided_by" AS ENUM('system', 'user');--> statement-breakpoint
CREATE TYPE "public"."match_decision" AS ENUM('auto_matched', 'ambiguous', 'rejected');--> statement-breakpoint
CREATE TABLE "erp_checkins" (
	"erp_id" text PRIMARY KEY NOT NULL,
	"erp_client_id" text NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erp_clients" (
	"erp_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"photo_path" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"erp_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erp_employees" (
	"erp_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"photo_path" text,
	"photo_hash" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"erp_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"detection_id" uuid,
	"erp_checkin_id" text,
	"confidence_score" real,
	"decision" "match_decision" NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" "match_decided_by" DEFAULT 'system' NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "match_attempts" ADD CONSTRAINT "match_attempts_detection_id_detections_id_fk" FOREIGN KEY ("detection_id") REFERENCES "public"."detections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_attempts" ADD CONSTRAINT "match_attempts_erp_checkin_id_erp_checkins_erp_id_fk" FOREIGN KEY ("erp_checkin_id") REFERENCES "public"."erp_checkins"("erp_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "erp_checkins_client_idx" ON "erp_checkins" USING btree ("erp_client_id");--> statement-breakpoint
CREATE INDEX "erp_checkins_occurred_idx" ON "erp_checkins" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "erp_checkins_unprocessed_idx" ON "erp_checkins" USING btree ("occurred_at") WHERE "erp_checkins"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "erp_clients_name_idx" ON "erp_clients" USING btree ("name");--> statement-breakpoint
CREATE INDEX "erp_employees_name_idx" ON "erp_employees" USING btree ("name");--> statement-breakpoint
CREATE INDEX "match_attempts_decision_idx" ON "match_attempts" USING btree ("decision");--> statement-breakpoint
CREATE INDEX "match_attempts_detection_idx" ON "match_attempts" USING btree ("detection_id");--> statement-breakpoint
CREATE INDEX "match_attempts_checkin_idx" ON "match_attempts" USING btree ("erp_checkin_id");--> statement-breakpoint
CREATE INDEX "match_attempts_pending_idx" ON "match_attempts" USING btree ("decided_at") WHERE "match_attempts"."decision" = 'ambiguous';