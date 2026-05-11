/**
 * Decide se um novo evento deve iniciar uma nova sessão ou continuar a atual.
 * Lógica: nova sessão se não há aberta OU se gap entre `lastSeenAt` da última
 * detecção e `eventAt` é >= `gapMs`.
 *
 * Esta função é puramente determinística — caller (pipeline) é responsável por
 * buscar `lastSeenAt` da sessão aberta para o (camera_id, track_id) específico.
 */
export function shouldStartNewSession(
  lastSeenAt: Date | null,
  eventAt: Date,
  gapMs: number,
): boolean {
  if (!lastSeenAt) return true;
  const diff = eventAt.getTime() - lastSeenAt.getTime();
  return diff < 0 || diff >= gapMs;
}
