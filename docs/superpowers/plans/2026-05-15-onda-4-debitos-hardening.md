# Onda 4 — Débitos & Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pay down 3 deferred Onda 3 tech debts (N+1 query, monorepo typecheck resolution, service-user home) and formally register 2 deferred items — no product behavior change.

**Architecture:** D1 extracts the inline `listPending` closure from `server.ts` into a dedicated, testable module and replaces per-match detection queries with a single union-range query + in-memory windowing. D2 adds root-anchored `baseUrl`/`paths` to `tsconfig.base.json` and relists the web `paths` block (no deep-merge in `extends`). D3 moves the `vipcam` service-user home to `/var/lib/vipcam` in `install.sh` and pins `HOME` defensively in both systemd units.

**Tech Stack:** Bun + Hono + Drizzle + PostgreSQL (edge), Next.js 14 (web), TypeScript composite project references, systemd, bash.

**Spec:** `docs/superpowers/specs/2026-05-15-onda-4-debitos-hardening-design.md` (approved by spec-reviewer).

**Constraint:** Implementable fully offline. Operational validation of D3 (running `install.sh` on the VPS) and the nginx SSE apply are deferred until server access is restored — documented, not executed here.

---

## Chunk 1: Onda 4 — Débitos & Hardening

### File Structure

- **Create:** `packages/edge/src/api/match-pending.ts` — extracted `listPendingEnriched` logic (single-query D1 fix). One responsibility: build `MatchPendingEnriched[]` from pending match_attempts.
- **Create:** `packages/edge/tests/integration/api/match-pending.test.ts` — integration test proving correct per-window candidate assignment across multiple pending matches.
- **Modify:** `packages/edge/src/api/server.ts:140-226` — replace the inline `listPending` closure body with a call to the extracted function; drop now-unused imports if any.
- **Modify:** `tsconfig.base.json` — add `baseUrl` + `paths` for `@vipcam/shared`.
- **Modify:** `packages/web/tsconfig.json` — relist full `paths` block root-relative.
- **Modify:** `infra/install.sh` — `useradd --home /var/lib/vipcam` + idempotent `usermod` block + mkdir/chown.
- **Modify:** `infra/systemd/vipcam-edge.service`, `infra/systemd/vipcam-web.service` — add `Environment=HOME=/var/lib/vipcam`.
- **Modify:** `docs/superpowers/specs/2026-05-14-onda-3-frontend-visibility-design.md` (Section 0) — register nginx SSE operational-pending + Failover B future-gated onda.

---

### Task 1: D1 — Failing integration test for multi-window candidate assignment

**Files:**
- Create: `packages/edge/tests/integration/api/match-pending.test.ts`
- Reference (read only): `packages/edge/tests/integration/match-temp/orchestrator.test.ts` (test DB harness pattern), `packages/edge/tests/integration/persistence/_helpers.ts` (`truncateAll`), `packages/edge/src/match-temp/orchestrator.ts` (`processCheckin` creates ambiguous attempts), `packages/edge/src/api/server.ts:143-222` (current logic to extract)

The D1 logic currently lives as an inline closure inside `createServer()` in `server.ts` — not directly testable. Task 2 extracts it to `packages/edge/src/api/match-pending.ts` exporting `listPendingEnriched(limit: number): Promise<MatchPendingEnriched[]>` (uses `getDb()` + `getEnv()` internally, same as the closure does today). This test imports that not-yet-existing function — it MUST fail first on the missing module.

The test seeds **two distinct pending (ambiguous) match_attempts** whose checkins have **non-overlapping** time windows, plus anonymous detections placed so that each window contains its own candidates and at least one detection falls **outside both** windows. Reuse `processCheckin` (proven in `orchestrator.test.ts`) to create ambiguous attempts: 2+ anonymous detections in a window → ambiguous attempt with no linking. With default `MATCH_WINDOW_SECONDS` (±5min), windows centered ~30min apart do not overlap.

- [ ] **Step 1: Write the failing test**

```typescript
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { listPendingEnriched } from "../../../src/api/match-pending.js";
import { processCheckin } from "../../../src/match-temp/orchestrator.js";
import { closeDb } from "../../../src/persistence/db.js";
import {
  camerasRepo,
  detectionsRepo,
  erpRepo,
  sessionsRepo,
} from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "../persistence/_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

// Seeds an ambiguous match_attempt for `erpClientId` whose checkin is centered
// at `center`, with `count` anonymous detections at `center` (all inside the
// ±MATCH_WINDOW window) so processCheckin records it as ambiguous (no linking).
async function seedAmbiguous(opts: {
  cameraName: string;
  ipSuffix: number;
  erpClientId: string;
  clientName: string;
  checkinErpId: string;
  center: Date;
  candidateCount: number;
}): Promise<void> {
  const cam = await camerasRepo.create({
    name: opts.cameraName,
    ip_address: `10.0.0.${opts.ipSuffix}`,
  });
  await erpRepo.upsertClient({
    erp_id: opts.erpClientId,
    name: opts.clientName,
    is_active: true,
  });
  for (let i = 0; i < opts.candidateCount; i++) {
    const sess = await sessionsRepo.create({
      camera_id: cam.id,
      current_track_id: `${opts.checkinErpId}-t${i}`,
      started_at: opts.center,
      last_seen_at: opts.center,
      detection_count: 1,
    });
    await detectionsRepo.create({
      camera_id: cam.id,
      session_id: sess.id,
      detected_at: opts.center,
      raw_event: {},
      face_attrs: {},
    });
  }
  const checkin = await erpRepo.upsertCheckin({
    erp_id: opts.checkinErpId,
    erp_client_id: opts.erpClientId,
    event_type: "appointment_confirmed",
    occurred_at: new Date(opts.center.getTime() + 30_000),
  });
  await processCheckin(checkin);
}

describe("listPendingEnriched (D1 — single-query candidate assignment)", () => {
  test("each pending match gets only the candidates inside its own window", async () => {
    const centerA = new Date("2026-05-01T14:00:00Z");
    const centerB = new Date("2026-05-01T15:00:00Z"); // 1h apart → windows disjoint

    await seedAmbiguous({
      cameraName: "camA",
      ipSuffix: 1,
      erpClientId: "cli-A",
      clientName: "Cliente A",
      checkinErpId: "chk-A",
      center: centerA,
      candidateCount: 2,
    });
    await seedAmbiguous({
      cameraName: "camB",
      ipSuffix: 2,
      erpClientId: "cli-B",
      clientName: "Cliente B",
      checkinErpId: "chk-B",
      center: centerB,
      candidateCount: 3,
    });

    // A detection far outside BOTH windows must never be returned.
    const camC = await camerasRepo.create({ name: "camC", ip_address: "10.0.0.9" });
    const sessC = await sessionsRepo.create({
      camera_id: camC.id,
      current_track_id: "noise",
      started_at: new Date("2026-05-01T20:00:00Z"),
      last_seen_at: new Date("2026-05-01T20:00:00Z"),
      detection_count: 1,
    });
    await detectionsRepo.create({
      camera_id: camC.id,
      session_id: sessC.id,
      detected_at: new Date("2026-05-01T20:00:00Z"),
      raw_event: {},
      face_attrs: {},
    });

    const result = await listPendingEnriched(50);

    expect(result).toHaveLength(2);
    const byCheckin = new Map(result.map((r) => [r.checkin.erp_id, r]));

    const a = byCheckin.get("chk-A");
    const b = byCheckin.get("chk-B");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a?.candidates).toHaveLength(2);
    expect(b?.candidates).toHaveLength(3);

    // No candidate of A is within B's window and vice-versa, and the
    // far-outside noise detection appears in neither.
    const aTimes = a?.candidates.map((c) => new Date(c.detected_at).getTime()) ?? [];
    const bTimes = b?.candidates.map((c) => new Date(c.detected_at).getTime()) ?? [];
    for (const t of aTimes) expect(Math.abs(t - centerA.getTime())).toBeLessThan(310_000);
    for (const t of bTimes) expect(Math.abs(t - centerB.getTime())).toBeLessThan(310_000);
  });

  test("zero pending matches → [] with no further queries (early return preserved)", async () => {
    const result = await listPendingEnriched(50);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails for the right reason**

Run: `cd packages/edge && bun test tests/integration/api/match-pending.test.ts`
Expected: FAIL — module resolution error `Cannot find module '../../../src/api/match-pending.js'` (function not yet extracted). This confirms the test targets the extraction, not a pre-existing path.

---

### Task 2: D1 — Extract + single-query refactor, make the test pass

**Files:**
- Create: `packages/edge/src/api/match-pending.ts`
- Modify: `packages/edge/src/api/server.ts` (replace inline closure body lines ~143-222 with a call; remove imports that become unused only in `server.ts`)

The current closure (server.ts:143-222) does: `matchAttemptsRepo.findPending(limit)` → early-return `[]` if empty → one JOIN query building `checkinsById` → **`for` loop issuing one detections query per match**. The fix keeps the structure but replaces the per-match loop query with **one** union-range query, assigning candidates in memory per-match via `computeWindow`.

- [ ] **Step 1: Create `packages/edge/src/api/match-pending.ts`**

```typescript
import type { MatchPendingEnriched } from "@vipcam/shared";
import { and, asc, between, eq, inArray, isNull } from "drizzle-orm";
import { getEnv } from "../config/env.js";
import { computeWindow } from "../match-temp/window.js";
import { getDb } from "../persistence/db.js";
import { matchAttemptsRepo } from "../persistence/repositories/index.js";
import { detections } from "../persistence/schema/detections.js";
import { erpCheckins, erpClients } from "../persistence/schema/erp-cache.js";
import { persons } from "../persistence/schema/persons.js";

/**
 * Lista match_attempts ambíguos enriquecidos com info do checkin + candidatas.
 *
 * D1 (Onda 4): antes este código emitia UMA query de detections POR match
 * (N+1). Agora faz UMA query única no range-união de todas as janelas e
 * atribui candidatas a cada match em memória filtrando pela janela específica
 * daquele checkin. Mesmo padrão de sessionsRepo.listByPerson (1 query +
 * agrupamento em memória). Interface pública MatchPendingEnriched inalterada.
 */
export async function listPendingEnriched(limit: number): Promise<MatchPendingEnriched[]> {
  const db = getDb();
  const env = getEnv();
  const attempts = await matchAttemptsRepo.findPending(limit);
  if (attempts.length === 0) return [];

  const checkinIds = attempts
    .map((a) => a.erp_checkin_id)
    .filter((x): x is string => x !== null);
  const checkinRows =
    checkinIds.length > 0
      ? await db
          .select({
            erp_id: erpCheckins.erp_id,
            erp_client_id: erpCheckins.erp_client_id,
            occurred_at: erpCheckins.occurred_at,
            event_type: erpCheckins.event_type,
            client_name: erpClients.name,
            client_phone: erpClients.phone,
            person_id: persons.id,
          })
          .from(erpCheckins)
          .leftJoin(erpClients, eq(erpCheckins.erp_client_id, erpClients.erp_id))
          .leftJoin(persons, eq(persons.erp_client_id, erpCheckins.erp_client_id))
          .where(inArray(erpCheckins.erp_id, checkinIds))
      : [];
  const checkinsById = new Map(checkinRows.map((c) => [c.erp_id, c]));

  // Resolve a janela de cada match uma vez; deriva o range-união.
  type Resolved = {
    attempt: (typeof attempts)[number];
    checkin: NonNullable<ReturnType<typeof checkinsById.get>>;
    window: { start: Date; end: Date };
  };
  const resolved: Resolved[] = [];
  for (const a of attempts) {
    if (!a.erp_checkin_id) continue;
    const checkin = checkinsById.get(a.erp_checkin_id);
    if (!checkin) continue;
    const window = computeWindow(checkin.occurred_at, env.MATCH_WINDOW_SECONDS);
    resolved.push({ attempt: a, checkin, window });
  }
  if (resolved.length === 0) return [];

  let unionStart = resolved[0]!.window.start;
  let unionEnd = resolved[0]!.window.end;
  for (const r of resolved) {
    if (r.window.start < unionStart) unionStart = r.window.start;
    if (r.window.end > unionEnd) unionEnd = r.window.end;
  }

  // UMA query única — todas as detections anônimas no range-união.
  const allDet = await db
    .select({
      id: detections.id,
      detected_at: detections.detected_at,
      snapshot_path: detections.snapshot_path,
      face_attrs: detections.face_attrs,
      dominant_emotion: detections.dominant_emotion,
      emotion_confidence: detections.emotion_confidence,
      session_id: detections.session_id,
      camera_id: detections.camera_id,
    })
    .from(detections)
    .where(
      and(
        isNull(detections.person_id),
        between(detections.detected_at, unionStart, unionEnd),
      ),
    )
    .orderBy(asc(detections.detected_at));

  // Atribui candidatas por match em memória, filtrando pela janela específica.
  return resolved.map(({ attempt: a, checkin, window }) => {
    const candidatesDet = allDet.filter(
      (d) => d.detected_at >= window.start && d.detected_at <= window.end,
    );
    return {
      match_attempt_id: a.id,
      decided_at: a.decided_at.toISOString(),
      notes: a.notes,
      checkin: {
        erp_id: checkin.erp_id,
        client_name: checkin.client_name,
        client_phone: checkin.client_phone,
        erp_client_id: checkin.erp_client_id,
        person_id: checkin.person_id,
        occurred_at: checkin.occurred_at.toISOString(),
        event_type: checkin.event_type,
      },
      candidates: candidatesDet.map((d) => ({
        id: d.id,
        detected_at: d.detected_at.toISOString(),
        snapshot_path: d.snapshot_path,
        face_attrs: d.face_attrs as Record<string, unknown>,
        dominant_emotion: d.dominant_emotion,
        emotion_confidence: d.emotion_confidence,
        session_id: d.session_id,
        camera_id: d.camera_id,
      })),
    };
  });
}
```

Note: `allDet.filter` is `[start, end]` inclusive to match the previous Drizzle `between` semantics exactly (no behavior change).

- [ ] **Step 2: Wire `server.ts` to the extracted function**

In `packages/edge/src/api/server.ts`, replace the entire inline `listPending: async (limit) => { ... }` closure (lines ~143-222) with:

```typescript
      listPending: (limit) => listPendingEnriched(limit),
```

Add the import near the other `./` imports (e.g., after line 25 `import { fetchDashboardSummary } from "./dashboard.queries.js";`):

```typescript
import { listPendingEnriched } from "./match-pending.js";
```

Then remove imports that are now unused **in server.ts only** (verify each is not referenced elsewhere in the file before deleting): `computeWindow`, `between`, `asc`, `isNull`, and the `detections` schema import — and prune `and` / `inArray` / `eq` / `persons` / `erpClients` / `erpCheckins` / `detectionsRepo` ONLY if grep confirms zero remaining uses in `server.ts`. Do not guess — check with grep.

- [ ] **Step 3: Run the D1 test — expect PASS**

Run: `cd packages/edge && bun test tests/integration/api/match-pending.test.ts`
Expected: PASS (2/2). If the test DB is unavailable, this is the one task with an environmental dependency — see Task 8 fallback note.

- [ ] **Step 4: Run the full edge suite — no regression**

Run: `cd packages/edge && bun test`
Expected: All pass (same baseline as before; `matches.test.ts` route unit test still green since the route contract is unchanged).

- [ ] **Step 5: Typecheck edge**

Run: `bun run typecheck`
Expected: exit 0 (3/3). Confirms the extraction has no type errors and the unused-import pruning didn't break compilation.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/api/match-pending.ts packages/edge/src/api/server.ts packages/edge/tests/integration/api/match-pending.test.ts
git commit -m "$(cat <<'EOF'
fix(edge): D1 — eliminate N+1 in GET /api/matches/pending

Extract listPending into match-pending.ts; replace per-match detection
queries with a single union-range query + in-memory per-window candidate
assignment. Public MatchPendingEnriched contract unchanged.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: D2 — Add root-anchored baseUrl + @vipcam/shared paths to tsconfig.base.json

**Files:**
- Modify: `tsconfig.base.json`
- Reference (read only, already confirmed): `packages/shared/package.json` — `main`/`types`/`exports["."]` all `./src/index.ts`; `exports["./types"]` → `./src/types/index.ts`. So path target `packages/shared/src/index.ts` is correct.

`tsconfig.base.json` currently has NO `baseUrl` and NO `paths`. In an `extends`-ed config, path options resolve relative to the dir of the file that declares them (TS ≥5.0), so declaring `"baseUrl": "."` here anchors at the repo root (tsconfig.base.json lives at root).

- [ ] **Step 1: Edit `tsconfig.base.json`**

Add to `compilerOptions` (after `"forceConsistentCasingInFileNames": true`):

```jsonc
"baseUrl": ".",
"paths": {
  "@vipcam/shared": ["packages/shared/src/index.ts"],
  "@vipcam/shared/*": ["packages/shared/src/*"]
}
```

(Remember to add a comma after `"forceConsistentCasingInFileNames": true` since it is currently the last key.)

- [ ] **Step 2: Commit (partial — web fix follows in Task 4)**

Do NOT commit yet — D2 is only safe as base+web together. Proceed directly to Task 4; a single commit covers both files.

---

### Task 4: D2 — Relist web paths root-relative (extends does not deep-merge paths)

**Files:**
- Modify: `packages/web/tsconfig.json`

`packages/web/tsconfig.json` has its own `"paths": { "@/*": ["./src/*"] }`. A child `paths` block fully **replaces** the parent's — it does not merge. So the `@vipcam/shared` entries from base would be ignored by web unless relisted here. Also, introducing `baseUrl="."` (root) changes the meaning of web's `@/*`: `./src/*` would resolve to `<root>/src/*` (nonexistent). It must become root-relative.

- [ ] **Step 1: Edit `packages/web/tsconfig.json`**

Replace:

```jsonc
"paths": { "@/*": ["./src/*"] },
```

with:

```jsonc
"paths": {
  "@/*": ["packages/web/src/*"],
  "@vipcam/shared": ["packages/shared/src/index.ts"],
  "@vipcam/shared/*": ["packages/shared/src/*"]
},
```

`packages/edge/tsconfig.json` and `packages/shared/tsconfig.json` are **NOT** modified (edge has no own `paths` → inherits base; shared uses no aliases).

- [ ] **Step 2: Validation battery — typecheck 3/3**

Run: `bun run typecheck`
Expected: exit 0, shared + web + edge all pass.

- [ ] **Step 3: Validation — isolated consumers (the core D2 goal)**

Run: `bun --filter '@vipcam/edge' typecheck`
Expected: PASS without relying on a freshly-built `packages/shared/dist` (resolves `@vipcam/shared` by source).

Run: `bun --filter '@vipcam/web' typecheck`
Expected: PASS.

- [ ] **Step 4: Validation — web `@/*` still resolves + Next build (trap #2)**

Run: `cd packages/web && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS — confirms `@/components/*`, `@/lib/*` imports across `src/` still resolve under the new root-anchored `@/*`.

Run: `cd packages/web && bun run build`
Expected: Next build succeeds (pages already `force-dynamic`; Next resolves `@/*` via tsconfig and `@vipcam/shared` via `transpilePackages`). This is the definitive trap-#2 guard.

- [ ] **Step 5: Validation — runtimes / test suites unaffected**

Run: `cd packages/edge && bun test`
Run: `cd packages/web && bun test`
Expected: No regression (paths is compile-time only; edge runtime uses the workspace symlink, web runtime uses the Next bundler).

- [ ] **Step 6: Commit (base + web together)**

```bash
git add tsconfig.base.json packages/web/tsconfig.json
git commit -m "$(cat <<'EOF'
fix(build): D2 — resolve @vipcam/shared by source in monorepo typecheck

Add root-anchored baseUrl + @vipcam/shared paths to tsconfig.base.json so
isolated consumer typechecks don't depend on stale shared/dist. Relist
web's paths root-relative (extends does not deep-merge paths; baseUrl
move requires @/* to become packages/web/src/*).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: D3 — Move vipcam service-user home to /var/lib/vipcam in install.sh

**Files:**
- Modify: `infra/install.sh` (section "1. Usuário de sistema", lines 34-43)

`install.sh` currently does `useradd --system --home "$APP_DIR"` (= `/opt/vipcamv2`), so the service user's dotfiles (`.bun/`, `.cache/`, `.config/`, `.lesshst`) land inside the git checkout. Move home to `/var/lib/vipcam`, idempotently fixing an already-provisioned VPS.

- [ ] **Step 1: Edit `infra/install.sh` section 1**

Add a constant near the others (after line 23 `SERVICE_USER="${SERVICE_USER:-vipcam}"`):

```bash
SERVICE_HOME="/var/lib/vipcam"
```

Replace the section 1 block (lines 34-43):

```bash
# ----- 1. Usuário de sistema -----
if id -u "$SERVICE_USER" &>/dev/null; then
  log "usuário $SERVICE_USER já existe"
else
  log "criando usuário $SERVICE_USER"
  useradd --system --home "$APP_DIR" --shell /bin/bash "$SERVICE_USER"
fi

# Dono dos arquivos do repo
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
```

with:

```bash
# ----- 1. Usuário de sistema -----
# Home = /var/lib/vipcam (NÃO o checkout do repo). Caso contrário os
# dotfiles do bun (~/.bun, ~/.cache, ~/.config, ~/.lesshst) seriam criados
# dentro de /opt/vipcamv2 e poluiriam o git status / risco de `git add .`.
if id -u "$SERVICE_USER" &>/dev/null; then
  log "usuário $SERVICE_USER já existe"
  cur_home="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
  if [[ "$cur_home" != "$SERVICE_HOME" ]]; then
    log "movendo home de $SERVICE_USER: $cur_home -> $SERVICE_HOME"
    usermod -d "$SERVICE_HOME" "$SERVICE_USER"
    warn "dotfiles antigos em $cur_home NÃO foram migrados (passo operacional"
    warn "  manual, não-destrutivo): após confirmar o serviço OK, limpe"
    warn "  $cur_home/.bun $cur_home/.cache $cur_home/.config $cur_home/.lesshst"
  fi
else
  log "criando usuário $SERVICE_USER (home $SERVICE_HOME)"
  useradd --system --home "$SERVICE_HOME" --shell /bin/bash "$SERVICE_USER"
fi

# Home do service user (bun precisa de HOME gravável p/ ~/.bun/install/cache)
mkdir -p "$SERVICE_HOME"
chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME"
chmod 750 "$SERVICE_HOME"

# Dono dos arquivos do repo
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
```

- [ ] **Step 2: Validate shell syntax**

Run: `bash -n infra/install.sh`
Expected: exit 0, no output (syntax OK). Functional validation (running on VPS, `getent passwd vipcam`, deploy.sh still works) is **operational — deferred** per spec; recorded in Task 7.

---

### Task 6: D3 — Pin HOME defensively in both systemd units

**Files:**
- Modify: `infra/systemd/vipcam-edge.service`
- Modify: `infra/systemd/vipcam-web.service`

Both units run `bun` as `User=vipcam` with `ProtectHome=read-only` and no explicit `HOME`. bun derives `~/.bun/install/cache` from `/etc/passwd`. After D3 that's `/var/lib/vipcam` — pin it explicitly so the unit is self-documenting and robust if the passwd entry drifts. `ReadWritePaths` already grants `/opt/vipcamv2`; add `/var/lib/vipcam` so the bun cache dir under the new HOME is writable despite `ProtectHome=read-only`.

- [ ] **Step 1: Edit `infra/systemd/vipcam-edge.service`**

After line 16 `Environment=PATH=/usr/local/bin:/usr/bin:/bin`, add:

```ini
Environment=HOME=/var/lib/vipcam
```

Change line 36 from:

```ini
ReadWritePaths=/var/log/vipcam /opt/vipcamv2 /tmp
```

to:

```ini
ReadWritePaths=/var/log/vipcam /opt/vipcamv2 /var/lib/vipcam /tmp
```

- [ ] **Step 2: Edit `infra/systemd/vipcam-web.service`**

After line 16 `Environment=PATH=/usr/local/bin:/usr/bin:/bin`, add:

```ini
Environment=HOME=/var/lib/vipcam
```

Change line 33 from:

```ini
ReadWritePaths=/var/log/vipcam /opt/vipcamv2 /tmp
```

to:

```ini
ReadWritePaths=/var/log/vipcam /opt/vipcamv2 /var/lib/vipcam /tmp
```

- [ ] **Step 3: Sanity-check unit files**

Run: `grep -n 'HOME\|ReadWritePaths' infra/systemd/vipcam-edge.service infra/systemd/vipcam-web.service`
Expected: each file shows `Environment=HOME=/var/lib/vipcam` and a `ReadWritePaths` line including `/var/lib/vipcam`. (`systemd-analyze verify` is operational/VPS-only — deferred.)

- [ ] **Step 4: Commit D3**

```bash
git add infra/install.sh infra/systemd/vipcam-edge.service infra/systemd/vipcam-web.service
git commit -m "$(cat <<'EOF'
fix(infra): D3 — move vipcam service-user home to /var/lib/vipcam

useradd --home /var/lib/vipcam + idempotent usermod for already-provisioned
VPS; pin HOME and grant ReadWritePaths in both systemd units so bun's
cache lives outside the git checkout. Operational apply deferred.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Register deferred items (nginx SSE + Failover B) in Onda 3 spec Section 0

**Files:**
- Modify: `docs/superpowers/specs/2026-05-14-onda-3-frontend-visibility-design.md` (Section 0 — "Estado atual / operacional")

Document the two formally-deferred items so the project history is unambiguous. Do not duplicate the full Failover B / nginx text — the Onda 4 spec (Section 3) is the source of truth; Section 0 of the Onda 3 spec gets a short pointer.

- [ ] **Step 1: Locate Section 0**

Run: `grep -n '^## 0\|^# \|^## Section 0\|Estado' "docs/superpowers/specs/2026-05-14-onda-3-frontend-visibility-design.md"`
Expected: identifies the Section 0 heading and its end. If there is no Section 0, append a new `## 0. Estado operacional pós-Onda 3` section near the top (after the front-matter/objetivo).

- [ ] **Step 2: Add the deferred-items note**

Insert under Section 0:

```markdown
### Débitos diferidos (resolvidos / registrados na Onda 4)

- **nginx SSE 502** — corrigido em código no commit `2e3b7d0`
  (`location = /api/events/stream`, `Connection ""`, buffering/cache off,
  read_timeout 3600s). **Aplicação operacional pendente** (passo manual de
  nginx, fora do deploy.sh): `git pull` no VPS + `cp` do vhost +
  `nginx -t && systemctl reload nginx`. Aplicar quando houver acesso ao
  servidor.
- **Failover B (re-id local InsightFace + pgvector)** — onda futura, com
  **gate obrigatório**: probe na câmera DH-IPC-HFW5442T-ASE para determinar
  a fonte da imagem de rosto antes de desenhar. M4 (`snapshotUrl` flat
  filename) anexado a essa onda. Detalhes em
  `docs/superpowers/specs/2026-05-15-onda-4-debitos-hardening-design.md`
  Seção 3.
```

- [ ] **Step 3: Commit docs**

```bash
git add "docs/superpowers/specs/2026-05-14-onda-3-frontend-visibility-design.md"
git commit -m "$(cat <<'EOF'
docs: register deferred nginx SSE + Failover B in Onda 3 Section 0

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Final verification + branch finish

**Files:** none (verification only)

- [ ] **Step 1: Full repo typecheck**

Run: `bun run typecheck`
Expected: exit 0, 3/3.

- [ ] **Step 2: Full edge test suite**

Run: `cd packages/edge && bun test`
Expected: All pass. **Fallback note:** if the integration test DB (`vipcam_test` Postgres) is not reachable in this environment, the D1 integration test (Task 1/2) cannot execute. In that case: confirm the test file is syntactically valid and typechecks (`bun run typecheck` passes), commit it, and explicitly flag in the final summary that D1's integration test must be run where Postgres is available before merge. Do NOT delete or weaken the test to make it pass.

- [ ] **Step 3: Web build sanity (D2 trap-2 final guard)**

Run: `cd packages/web && bun run build`
Expected: success.

- [ ] **Step 4: Lint (if configured)**

Run: `bun run lint` (root) — if the script exists.
Expected: no new errors. Skip if no lint script.

- [ ] **Step 5: Finish the development branch**

Use the **superpowers:finishing-a-development-branch** skill to review, merge to master, and push. Include in the merge summary: which validations ran here vs. which are operationally deferred (D3 VPS apply; nginx SSE VPS apply; D1 integration test if no test DB locally).

---

## Operational follow-up (NOT part of this plan's code — do when VPS access is restored)

1. nginx SSE apply (commit `2e3b7d0` + this plan's vhost): `cd /opt/vipcamv2 && sudo -u vipcam git pull origin master && sudo cp infra/nginx/monitoramento.franquiabv.com.br.conf /etc/nginx/sites-available/monitoramento.franquiabv.com.br && sudo nginx -t && sudo systemctl reload nginx`
2. D3 apply: `sudo APP_DIR=/opt/vipcamv2 /opt/vipcamv2/infra/install.sh` → verify `getent passwd vipcam` shows `/var/lib/vipcam`, `sudo systemctl daemon-reload && sudo systemctl restart vipcam-edge vipcam-web`, confirm services healthy and new dotfiles land under `/var/lib/vipcam`. Then manually clean orphaned dotfiles under `/opt/vipcamv2`.
3. D1: confirm the integration test passed where Postgres is available (if it could not run locally).
