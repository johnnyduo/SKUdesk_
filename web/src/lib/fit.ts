// How far the camera stands so a flat product card never fills more than `fill` of the picture, whatever its shape and whatever
// shape the panel is. The top of the panel carries the name and the bottom a hint, so the card has to stay well inside.
export const FILL = 0.56;

export function fitDistance(o: { hgt: number; wid: number; aspect: number; fovDeg: number; zoom?: number; fill?: number }): number {
  const fill = o.fill ?? FILL;
  const half = Math.tan((o.fovDeg * Math.PI) / 360);
  const forHeight = o.hgt / (2 * half * fill);
  const forWidth = o.wid / (2 * half * o.aspect * fill);
  return Math.max(forHeight, forWidth) / (o.zoom ?? 1) + 0.3;
}

/** The share of the view height and width the card covers at that distance. */
export function coverage(o: { hgt: number; wid: number; aspect: number; fovDeg: number; distance: number }): { height: number; width: number } {
  const half = Math.tan((o.fovDeg * Math.PI) / 360);
  const visibleH = 2 * o.distance * half;
  return { height: o.hgt / visibleH, width: o.wid / (visibleH * o.aspect) };
}
