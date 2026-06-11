import type { PaginatedResponse, PersonDetail, PersonSummary } from "@vipcam/shared";
import { and, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { detections } from "../schema/detections.js";
import { erpClients } from "../schema/erp-cache.js";
import { type NewPerson, type Person, persons } from "../schema/persons.js";
import { sessions } from "../schema/sessions.js";
import { faceRecordsRepo } from "./face-records.repo.js";

export const personsRepo = {
  async create(data: Omit<NewPerson, "id">): Promise<Person> {
    const [p] = await getDb().insert(persons).values(data).returning();
    if (!p) throw new Error("insert returned no row");
    return p;
  },

  async findById(id: string): Promise<Person | null> {
    const rows = await getDb().select().from(persons).where(eq(persons.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async findByErpClientId(erpId: string): Promise<Person | null> {
    const rows = await getDb()
      .select()
      .from(persons)
      .where(eq(persons.erp_client_id, erpId))
      .limit(1);
    return rows[0] ?? null;
  },

  async findByErpEmployeeId(erpId: string): Promise<Person | null> {
    const rows = await getDb()
      .select()
      .from(persons)
      .where(eq(persons.erp_employee_id, erpId))
      .limit(1);
    return rows[0] ?? null;
  },

  async update(id: string, patch: Partial<NewPerson>): Promise<Person | null> {
    const [p] = await getDb()
      .update(persons)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(persons.id, id))
      .returning();
    return p ?? null;
  },

  /**
   * Onda 11 — registra um avistamento da pessoa. Só conta VISITA NOVA se o
   * gap desde last_seen_at exceder gapHours (dedup: mesma pessoa detectada
   * várias vezes no mesmo período = 1 visita). UPDATE único atômico:
   * - CASE: gap > gapHours → +1; senão (inclusive out-of-order, gap negativo) +0.
   * - GREATEST: last_seen_at nunca regride com evento fora de ordem.
   * Substitui incrementVisitCount (que incrementava a cada detecção strict).
   */
  async recordSighting(id: string, detectedAt: Date, gapHours: number): Promise<void> {
    const at = detectedAt.toISOString();
    await getDb()
      .update(persons)
      .set({
        total_visits: sql`${persons.total_visits} + CASE WHEN ${at}::timestamptz - ${persons.last_seen_at} > make_interval(hours => ${gapHours}) THEN 1 ELSE 0 END`,
        last_seen_at: sql`GREATEST(${persons.last_seen_at}, ${at}::timestamptz)`,
        updated_at: sql`now()`,
      })
      .where(eq(persons.id, id));
  },

  /**
   * Onda 9-D — heurística "staff-like / onipresente": person com detecções em
   * >= minHours slots de hora distintos (date_trunc('hour')) nos últimos
   * lookbackDays dias. Proxy de "presente o dia todo, todo dia" (≠ cliente que
   * vem ~1h). Quem é staff-like é EXCLUÍDO do conjunto de candidatos do checkin
   * no match-temporal (não é quem deu checkin). Query indexada por
   * detections_person_idx + detected_idx.
   */
  async isStaffLike(personId: string, lookbackDays: number, minHours: number): Promise<boolean> {
    const [row] = await getDb()
      .select({
        activeHours: sql<number>`count(distinct date_trunc('hour', ${detections.detected_at}))::int`,
      })
      .from(detections)
      .where(
        and(
          eq(detections.person_id, personId),
          sql`${detections.detected_at} >= now() - make_interval(days => ${lookbackDays})`,
        ),
      );
    return (row?.activeHours ?? 0) >= minHours;
  },

  /**
   * Onda 10 — fila de curadoria "identificar funcionário": anônimos com ≥1
   * detecção, não-dispensados, ordenados por nº de detecções desc (mais visto
   * = mais provável staff). 2 queries (agregado + snapshots) + agrupamento em
   * memória — pattern Onda 4 D1.
   */
  async listIdentifyQueue(limit: number): Promise<
    Array<{
      person_id: string;
      detection_count: number;
      last_seen_at: Date | null;
      snapshots: string[];
    }>
  > {
    const rows = await getDb()
      .select({
        person_id: persons.id,
        detection_count: sql<number>`count(${detections.id})::int`,
        last_seen_at: persons.last_seen_at,
      })
      .from(persons)
      .innerJoin(detections, eq(detections.person_id, persons.id))
      .where(
        and(
          eq(persons.person_type, "anonymous"),
          sql`(${persons.metadata}->>'identify_dismissed') IS DISTINCT FROM 'true'`,
        ),
      )
      .groupBy(persons.id)
      .orderBy(sql`count(${detections.id}) DESC`)
      .limit(limit);

    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.person_id);
    const snaps = await getDb()
      .select({
        person_id: detections.person_id,
        snapshot_path: detections.snapshot_path,
      })
      .from(detections)
      .where(and(inArray(detections.person_id, ids), isNotNull(detections.snapshot_path)))
      .orderBy(desc(detections.detected_at));

    const byPerson = new Map<string, string[]>();
    for (const s of snaps) {
      if (!s.person_id || !s.snapshot_path) continue;
      const arr = byPerson.get(s.person_id) ?? [];
      if (arr.length < 3) {
        arr.push(s.snapshot_path);
        byPerson.set(s.person_id, arr);
      }
    }
    return rows.map((r) => ({ ...r, snapshots: byPerson.get(r.person_id) ?? [] }));
  },

  /**
   * Onda 10 — marca anônimo como dispensado da fila (ex.: cliente frequente).
   * `||` jsonb: atômico, preserva chaves existentes (sem read-modify-write race).
   */
  async dismissIdentify(id: string): Promise<void> {
    await getDb()
      .update(persons)
      .set({
        metadata: sql`${persons.metadata} || '{"identify_dismissed":true}'::jsonb`,
        updated_at: sql`now()`,
      })
      .where(eq(persons.id, id));
  },

  /**
   * Listagem paginada de pessoas com filtros opcionais por tipo e search
   * (display_name OR phone via JOIN com erp_clients). Ordenado por
   * last_seen_at desc, NULLs por último.
   *
   * Onda 3 (visibility dashboard).
   */
  async listWithFilters(params: {
    type?: "client" | "employee";
    search?: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<PersonSummary>> {
    const db = getDb();

    const whereClauses = [];
    if (params.type) whereClauses.push(eq(persons.person_type, params.type));
    if (params.search) {
      const pat = `%${params.search}%`;
      // search por display_name OR erp_clients.phone (subquery scalar)
      whereClauses.push(
        or(
          ilike(persons.display_name, pat),
          sql`EXISTS (SELECT 1 FROM ${erpClients} ec WHERE ec.erp_id = ${persons.erp_client_id} AND ec.phone ILIKE ${pat})`,
        ),
      );
    }
    const where = whereClauses.length ? and(...whereClauses) : undefined;

    const [items, totalRows] = await Promise.all([
      db
        .select({
          id: persons.id,
          display_name: persons.display_name,
          person_type: persons.person_type,
          photo_path: persons.thumbnail_path,
          last_seen_at: persons.last_seen_at,
          total_visits: persons.total_visits,
          erp_client_id: persons.erp_client_id,
          erp_employee_id: persons.erp_employee_id,
          phone: erpClients.phone,
        })
        .from(persons)
        .leftJoin(erpClients, eq(persons.erp_client_id, erpClients.erp_id))
        .where(where)
        .orderBy(sql`${persons.last_seen_at} DESC NULLS LAST`)
        .limit(params.limit)
        .offset(params.offset),
      db.select({ count: sql<number>`count(*)::int` }).from(persons).where(where),
    ]);

    return {
      items: items.map((row) => ({
        id: row.id,
        display_name: row.display_name,
        person_type: row.person_type,
        photo_path: row.photo_path,
        last_seen_at: row.last_seen_at?.toISOString() ?? null,
        total_visits: row.total_visits,
        erp_client_id: row.erp_client_id,
        erp_employee_id: row.erp_employee_id,
        phone: row.phone,
      })),
      total: totalRows[0]?.count ?? 0,
    };
  },

  /**
   * Versão enriquecida de findById que agrega first_seen_at + dominant_emotion
   * predominante (mode) + duração média das visitas, calculados via subqueries
   * em sessions. Onda 3 — usado pelo perfil em /people/[id].
   *
   * Retorna null se id não existe.
   */
  async findByIdWithStats(id: string): Promise<PersonDetail | null> {
    const db = getDb();
    const rows = await db
      .select({
        id: persons.id,
        display_name: persons.display_name,
        person_type: persons.person_type,
        photo_path: persons.thumbnail_path,
        last_seen_at: persons.last_seen_at,
        total_visits: persons.total_visits,
        erp_client_id: persons.erp_client_id,
        erp_employee_id: persons.erp_employee_id,
        phone: erpClients.phone,
        first_seen_at: sql<Date | null>`(SELECT MIN(${sessions.started_at}) FROM ${sessions} WHERE ${sessions.person_id} = ${persons.id})`,
        avg_dominant_emotion: sql<
          string | null
        >`(SELECT mode() WITHIN GROUP (ORDER BY ${sessions.dominant_emotion}) FROM ${sessions} WHERE ${sessions.person_id} = ${persons.id} AND ${sessions.dominant_emotion} IS NOT NULL)`,
        avg_visit_duration_min: sql<
          number | null
        >`(SELECT AVG(EXTRACT(EPOCH FROM (${sessions.ended_at} - ${sessions.started_at})) / 60.0)::float FROM ${sessions} WHERE ${sessions.person_id} = ${persons.id} AND ${sessions.ended_at} IS NOT NULL)`,
      })
      .from(persons)
      .leftJoin(erpClients, eq(persons.erp_client_id, erpClients.erp_id))
      .where(eq(persons.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      display_name: row.display_name,
      person_type: row.person_type,
      photo_path: row.photo_path,
      last_seen_at: row.last_seen_at?.toISOString() ?? null,
      total_visits: row.total_visits,
      erp_client_id: row.erp_client_id,
      erp_employee_id: row.erp_employee_id,
      phone: row.phone,
      first_seen_at: row.first_seen_at ? new Date(row.first_seen_at).toISOString() : null,
      avg_dominant_emotion: row.avg_dominant_emotion,
      avg_visit_duration_min: row.avg_visit_duration_min,
    };
  },

  /**
   * Hard merge transacional (Onda 7 §5.2): src some, todas as refs migram pra
   * dst, persons.dst absorve rollup de visitas, audit row inserida.
   *
   * Lock determinístico em ordem ascendente (LEAST primeiro) pra prevenir
   * deadlock entre dois operadores resolvendo merges sobrepostos.
   *
   * Subqueries posteriores ao FOR UPDATE são seguras porque srcId permanece
   * locked até COMMIT.
   */
  async mergeInto(srcId: string, dstId: string, userId: string): Promise<void> {
    if (srcId === dstId) {
      throw new Error("mergeInto: srcId and dstId are the same person");
    }
    const [leastId, greatestId] = srcId < dstId ? [srcId, dstId] : [dstId, srcId];
    await getDb().transaction(async (tx) => {
      // 1. Lock determinístico (dois statements separados — single ORDER BY IN(...) FOR UPDATE
      // não-garante ordem de lock acquisition no Postgres).
      const lockedLeast = await tx.execute<{ id: string }>(
        sql`SELECT id FROM persons WHERE id = ${leastId} FOR UPDATE`,
      );
      const lockedGreatest = await tx.execute<{ id: string }>(
        sql`SELECT id FROM persons WHERE id = ${greatestId} FOR UPDATE`,
      );
      if (lockedLeast.length === 0 || lockedGreatest.length === 0) {
        throw new Error(`mergeInto: person not found (${srcId} or ${dstId})`);
      }

      // 2. Migra refs simples (detections, sessions)
      await tx.execute(sql`UPDATE detections SET person_id = ${dstId} WHERE person_id = ${srcId}`);
      await tx.execute(sql`UPDATE sessions   SET person_id = ${dstId} WHERE person_id = ${srcId}`);

      // 3. face_records: reusa helper tx-aware (Task 11) — UPDATE + FIFO eviction
      // em dst após import (Top-K=5). DRY com insertAndEvict; mesma semântica.
      await faceRecordsRepo.transferToPerson(srcId, dstId, tx);

      // 4. Rollup das estatísticas — regras invariantes Onda 7 §5.2:
      //    - last_seen_at  = GREATEST(recência)
      //    - first_seen_at = LEAST (antiguidade)
      //    - total_visits  = soma
      //    - colunas nullable PRECISAM usar COALESCE (none aqui — todas NOT NULL).
      await tx.execute(sql`
        UPDATE persons
        SET total_visits  = persons.total_visits + (SELECT total_visits FROM persons WHERE id = ${srcId}),
            first_seen_at = LEAST(persons.first_seen_at,    (SELECT first_seen_at FROM persons WHERE id = ${srcId})),
            last_seen_at  = GREATEST(persons.last_seen_at,  (SELECT last_seen_at FROM persons WHERE id = ${srcId})),
            updated_at    = now()
        WHERE id = ${dstId}
      `);

      // 5. Audit ANTES do delete (snapshot completo de src)
      await tx.execute(sql`
        INSERT INTO person_merge_audit (src_id, dst_id, merged_at, merged_by, src_snapshot)
        VALUES (
          ${srcId}, ${dstId}, now(), ${userId},
          (SELECT row_to_json(persons.*) FROM persons WHERE id = ${srcId})
        )
      `);

      // 6. DELETE src. CASCADE em reid_match_attempts.candidate_person_id remove
      //    quaisquer rows pendentes apontando pra src (intencional — referência
      //    perdeu semântica).
      await tx.execute(sql`DELETE FROM persons WHERE id = ${srcId}`);
    });
  },
};
