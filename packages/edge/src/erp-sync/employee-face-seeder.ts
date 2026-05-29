/**
 * Onda 9-B — employee face seeder.
 *
 * Após syncEmployees criar/atualizar Person(employee), este módulo baixa
 * a foto do ERP, manda pro sidecar reid /embed (via bbox oversize trick →
 * frame_fallback path do sidecar), e persiste em face_records.
 *
 * Idempotente via persons.last_embedded_image_token: se imagem do ERP
 * não mudou desde o último seed, skip.
 *
 * HACK explícito: chamamos /embed com bbox (0,0,99999,99999) pra forçar
 * o sidecar a cair no `_embed_pil(full_frame)` (path documentado no
 * packages/reid/src/main.py:137 como "frame_fallback"). Sidecar v2+ pode
 * endurecer o guard "bbox deve caber no frame" — neste caso integration
 * test §6.3 cenário 2 falha como early-warning. Mitigação documentada em
 * spec §10 item #9: switch para opção B (/embed_image novo endpoint).
 */

const PLACEHOLDER_IMAGES: ReadonlySet<string> = new Set([
  "padrao.png",
  "padrao_masc.jpg",
  "padrao_fem.jpg",
]);

/** True quando o valor de `usuarios.imagem` é um placeholder do ERP
 * (não foto real). Set conhecido via probe 2026-05-28 (vide spec §2). */
export function isPlaceholder(photoUrl: string): boolean {
  return PLACEHOLDER_IMAGES.has(photoUrl);
}

/** Sanitiza o token do ERP pra filename safe — substitui `?` (query
 * string separator do cache-buster) e `/` (defensive path traversal)
 * por `_`. Tokens típicos do ERP: "avatar_1966.jpg?p8yr" → "avatar_1966.jpg_p8yr". */
export function sanitizeToken(token: string): string {
  return token.replace(/[?/]/g, "_");
}
