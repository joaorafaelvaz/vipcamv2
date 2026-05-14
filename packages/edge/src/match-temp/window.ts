/**
 * Janela temporal usada pelo match temporal (Onda 2 Chunk 4):
 * dado um checkin do ERP em `center`, busca detections anônimas em
 * [center - halfWidthSeconds, center + halfWidthSeconds].
 */
export interface TimeWindow {
  start: Date;
  end: Date;
}

export function computeWindow(center: Date, halfWidthSeconds: number): TimeWindow {
  const halfMs = halfWidthSeconds * 1000;
  return {
    start: new Date(center.getTime() - halfMs),
    end: new Date(center.getTime() + halfMs),
  };
}
