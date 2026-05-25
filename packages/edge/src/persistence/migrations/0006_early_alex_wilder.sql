CREATE TYPE "public"."reid_decided_by" AS ENUM('system', 'user');--> statement-breakpoint
CREATE TYPE "public"."reid_decision" AS ENUM('ambiguous', 'matched_to_candidate', 'rejected_new_person');--> statement-breakpoint
CREATE TABLE "reid_match_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"detection_id" uuid NOT NULL,
	"candidate_face_record_id" uuid NOT NULL,
	"candidate_person_id" uuid NOT NULL,
	"distance" real NOT NULL,
	"decision" "reid_decision" DEFAULT 'ambiguous' NOT NULL,
	"decided_by" "reid_decided_by" DEFAULT 'system' NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "reid_match_attempts" ADD CONSTRAINT "reid_match_attempts_detection_id_detections_id_fk" FOREIGN KEY ("detection_id") REFERENCES "public"."detections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reid_match_attempts" ADD CONSTRAINT "reid_match_attempts_candidate_face_record_id_face_records_id_fk" FOREIGN KEY ("candidate_face_record_id") REFERENCES "public"."face_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reid_match_attempts" ADD CONSTRAINT "reid_match_attempts_candidate_person_id_persons_id_fk" FOREIGN KEY ("candidate_person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reid_match_attempts_detection_idx" ON "reid_match_attempts" USING btree ("detection_id");--> statement-breakpoint
CREATE INDEX "reid_match_attempts_pending_idx" ON "reid_match_attempts" USING btree ("decided_at") WHERE "reid_match_attempts"."decision" = 'ambiguous';