-- HAND-EDITED (Onda 7): este arquivo foi editado MANUALMENTE após `db:generate`
-- pra inserir o guard abaixo. **NÃO re-rodar `db:generate` antes de commitar
-- este arquivo** — drizzle-kit detecta mudança no schema TS e regera, perdendo
-- o guard. Próximas migrations (Tasks 2/3) re-rodam db:generate, mas como
-- elas tocam OUTRAS tabelas, este 0005 fica intocado pelo regen.
DO $$
BEGIN
  IF (SELECT count(*) FROM face_records WHERE embedding IS NULL) > 0 THEN
    RAISE EXCEPTION 'face_records tem rows com embedding NULL — abortando migration. Investigar antes.';
  END IF;
END$$;
--> statement-breakpoint
ALTER TABLE "face_records" ALTER COLUMN "embedding" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "face_records" ADD COLUMN "model_name" text DEFAULT 'buffalo_s' NOT NULL;--> statement-breakpoint
ALTER TABLE "face_records" ADD COLUMN "model_revision" text DEFAULT 'insightface-0.7.3' NOT NULL;--> statement-breakpoint
ALTER TABLE "face_records" ADD COLUMN "det_score" real;