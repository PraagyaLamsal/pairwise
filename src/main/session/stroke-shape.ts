import { rectFromPoints, type Point, type Rect } from '@shared/geometry';

export type StrokeShape = 'circle' | 'underline' | 'arrow' | 'line' | 'scribble' | 'dot';

export interface ClassifiedStroke {
  shape: StrokeShape;
  bounds: Rect;
  start: Point;
  end: Point;
}

function pathLength(pts: Point[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return d;
}

/** Rough gesture recognition for the student's marks, used to describe them to the tutor. */
export function classifyStroke(points: Point[]): ClassifiedStroke {
  const bounds = rectFromPoints(points);
  const start = points[0];
  const end = points[points.length - 1];
  const L = pathLength(points);
  const span = Math.hypot(end.x - start.x, end.y - start.y);
  const size = Math.max(bounds.width, bounds.height);
  let shape: StrokeShape;
  if (size < 10) shape = 'dot';
  else if (span < size * 0.35 && L > size * 2.2) shape = 'circle';
  else if (L < span * 1.18) shape = bounds.height < bounds.width * 0.22 && bounds.width > 30 ? 'underline' : 'line';
  else if (bounds.height < bounds.width * 0.25 && bounds.width > 40) shape = 'underline';
  else if (L < span * 1.6 && span > 40) shape = 'arrow';
  else shape = 'scribble';
  return { shape, bounds, start, end };
}

const VERB: Record<StrokeShape, string> = {
  circle: 'circled',
  underline: 'underlined',
  arrow: 'drew an arrow pointing at',
  line: 'drew a line across',
  scribble: 'scribbled over',
  dot: 'tapped',
};

export function describeShape(s: StrokeShape): string {
  return VERB[s];
}
