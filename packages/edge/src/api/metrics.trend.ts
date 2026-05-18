/**
 * Tendência por mínimos quadrados sobre contagens diárias.
 * x = índice do dia (0..n-1), y = contagem. Função pura (Onda 5).
 * Deadband: |slope| < 0.05 visitas/dia → "flat" (ruído não vira tendência).
 */
export interface Trend {
  slope: number;
  direction: "up" | "down" | "flat";
}

const FLAT_DEADBAND = 0.05;

export function computeTrend(counts: number[]): Trend {
  const n = counts.length;
  if (n < 2) return { slope: 0, direction: "flat" };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const y = counts[i] ?? 0;
    sx += i;
    sy += y;
    sxx += i * i;
    sxy += i * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, direction: "flat" };
  const rawSlope = (n * sxy - sx * sy) / denom;
  // arredonda p/ estabilidade do snapshot/teste
  const slope = Math.round(rawSlope * 1000) / 1000;
  const direction =
    Math.abs(slope) < FLAT_DEADBAND ? "flat" : slope > 0 ? "up" : "down";
  return { slope, direction };
}
