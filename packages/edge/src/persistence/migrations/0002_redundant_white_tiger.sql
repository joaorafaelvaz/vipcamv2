CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid,
	"camera_id" uuid NOT NULL,
	"current_track_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"detection_count" integer DEFAULT 0 NOT NULL,
	"dominant_emotion" text,
	"avg_emotion_scores" jsonb DEFAULT '{}' NOT NULL,
	"linked_erp_checkin_id" text
);
--> statement-breakpoint
CREATE TABLE "detections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camera_id" uuid NOT NULL,
	"person_id" uuid,
	"session_id" uuid,
	"track_id" text,
	"bbox" jsonb,
	"face_attrs" jsonb DEFAULT '{}' NOT NULL,
	"dominant_emotion" text,
	"emotion_confidence" real,
	"snapshot_path" text,
	"detected_at" timestamp with time zone NOT NULL,
	"raw_event" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sentiment_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"detection_id" uuid,
	"session_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"emotion" text NOT NULL,
	"confidence" real NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_camera_id_cameras_id_fk" FOREIGN KEY ("camera_id") REFERENCES "public"."cameras"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detections" ADD CONSTRAINT "detections_camera_id_cameras_id_fk" FOREIGN KEY ("camera_id") REFERENCES "public"."cameras"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detections" ADD CONSTRAINT "detections_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detections" ADD CONSTRAINT "detections_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_records" ADD CONSTRAINT "sentiment_records_detection_id_detections_id_fk" FOREIGN KEY ("detection_id") REFERENCES "public"."detections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_records" ADD CONSTRAINT "sentiment_records_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_records" ADD CONSTRAINT "sentiment_records_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_person_idx" ON "sessions" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "sessions_camera_idx" ON "sessions" USING btree ("camera_id");--> statement-breakpoint
CREATE INDEX "sessions_started_idx" ON "sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "sessions_open_idx" ON "sessions" USING btree ("camera_id","started_at");--> statement-breakpoint
CREATE INDEX "sessions_open_track_idx" ON "sessions" USING btree ("camera_id","current_track_id") WHERE "sessions"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "detections_camera_idx" ON "detections" USING btree ("camera_id");--> statement-breakpoint
CREATE INDEX "detections_person_idx" ON "detections" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "detections_session_idx" ON "detections" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "detections_detected_idx" ON "detections" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "detections_anonymous_window_idx" ON "detections" USING btree ("detected_at") WHERE "detections"."person_id" IS NULL;--> statement-breakpoint
CREATE INDEX "sentiment_person_recorded_idx" ON "sentiment_records" USING btree ("person_id","recorded_at");--> statement-breakpoint
CREATE INDEX "sentiment_session_idx" ON "sentiment_records" USING btree ("session_id");