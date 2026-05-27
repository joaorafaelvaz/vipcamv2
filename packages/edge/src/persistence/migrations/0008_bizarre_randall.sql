ALTER TABLE "match_attempts" ADD COLUMN "previous_person_id" uuid;--> statement-breakpoint
ALTER TABLE "match_attempts" ADD COLUMN "previous_person_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "match_attempts" ADD CONSTRAINT "match_attempts_previous_person_id_persons_id_fk" FOREIGN KEY ("previous_person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;