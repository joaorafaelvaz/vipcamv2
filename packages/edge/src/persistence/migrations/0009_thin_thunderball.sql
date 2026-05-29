ALTER TABLE "persons" ADD COLUMN "last_embedded_image_token" text;--> statement-breakpoint
ALTER TABLE "face_records" ADD COLUMN "source" text DEFAULT 'live_detection' NOT NULL;