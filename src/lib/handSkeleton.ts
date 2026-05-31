import { NormalizedLandmarkList } from "@mediapipe/hands";

// ── Constants ──────────────────────────────────────────────────────────────

const TRAIL_LENGTH = 9;   // how many past frames to keep

// Finger chains — each is a sequence of landmark indices drawn as one smooth curve
const FINGER_CHAINS: number[][] = [
  [0, 1, 2, 3, 4],         // thumb
  [0, 5, 6, 7, 8],         // index
  [5, 9, 10, 11, 12],      // middle
  [9, 13, 14, 15, 16],     // ring
  [13, 17, 18, 19, 20],    // pinky
  [0, 17],                  // wrist→pinky palm edge
];

// Per-landmark colors — teal → violet → pink spectrum
const FINGER_COLORS: Record<number, string> = {
  0:  "#00ffe5",   // wrist   — teal
  1:  "#00ffe5",   2:  "#00ffe5",   3:  "#00ffe5",   4:  "#00ffe5",   // thumb
  5:  "#00cfff",   6:  "#00cfff",   7:  "#00cfff",   8:  "#00cfff",   // index
  9:  "#7b00ff",   10: "#7b00ff",   11: "#7b00ff",   12: "#7b00ff",   // middle
  13: "#d400ff",   14: "#d400ff",   15: "#d400ff",   16: "#d400ff",   // ring
  17: "#ff00aa",   18: "#ff00aa",   19: "#ff00aa",   20: "#ff00aa",   // pinky
};

const TIPS    = new Set([4, 8, 12, 16, 20]);
const KNUCKLES = new Set([1, 2, 5, 9, 13, 17]);

// ── Helpers ────────────────────────────────────────────────────────────────

type Pt = { x: number; y: number };

/** Normalize landmarks to pixel coords, mirroring X for front-facing camera */
function toLandmarkPts(
  landmarks: NormalizedLandmarkList,
  w: number, h: number,
): Pt[] {
  return landmarks.map(lm => ({ x: (1 - lm.x) * w, y: lm.y * h }));
}

/**
 * Draw a smooth quadratic bezier curve through an ordered list of points.
 * Passes through midpoints so the line visibly hits each joint.
 */
function drawSmoothChain(ctx: CanvasRenderingContext2D, pts: Pt[], chain: number[]) {
  if (chain.length < 2) return;
  const p0 = pts[chain[0]];
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);

  for (let i = 1; i < chain.length - 1; i++) {
    const curr = pts[chain[i]];
    const next = pts[chain[i + 1]];
    const midX = (curr.x + next.x) / 2;
    const midY = (curr.y + next.y) / 2;
    ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
  }
  const last = pts[chain[chain.length - 1]];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

// ── HandSkeletonRenderer class ────────────────────────────────────────────

export class HandSkeletonRenderer {
  /** Ring buffer of past landmark sets for the trail */
  private trail: NormalizedLandmarkList[] = [];

  /** Call when hand is lost to clear the trail */
  clear() { this.trail = []; }

  /** Main entry point — call every animation frame */
  draw(
    ctx: CanvasRenderingContext2D,
    landmarks: NormalizedLandmarkList,
    width: number,
    height: number,
    isPinching: boolean,
    isDeleteMode: boolean,
  ) {
    // Push current frame into trail buffer
    this.trail.push(landmarks);
    if (this.trail.length > TRAIL_LENGTH) this.trail.shift();

    ctx.clearRect(0, 0, width, height);

    // ── Draw trail frames (oldest → newest, increasingly opaque) ──
    for (let t = 0; t < this.trail.length - 1; t++) {
      const age  = t / (this.trail.length - 1); // 0 = oldest, ~1 = second-to-last
      const fade = Math.pow(age, 1.6);           // ease: older frames fall off faster
      this.drawTrailFrame(
        ctx,
        toLandmarkPts(this.trail[t], width, height),
        isPinching,
        isDeleteMode,
        fade,
      );
    }

    // ── Draw current frame at full brightness ──
    const pts = toLandmarkPts(landmarks, width, height);
    this.drawCurrentFrame(ctx, pts, isPinching, isDeleteMode);
  }

  // ── Trail frame: only glowing lines, no dots ──────────────────────────
  private drawTrailFrame(
    ctx: CanvasRenderingContext2D,
    pts: Pt[],
    isPinching: boolean,
    isDeleteMode: boolean,
    fade: number,   // 0 (invisible) → 1 (bright)
  ) {
    const primary = isDeleteMode ? "#ff2244" : isPinching ? "#ff00cc" : "#00ffe5";
    const glow    = isDeleteMode ? "#ff0000" : isPinching ? "#ff00ff" : "#00ffdd";

    ctx.save();
    ctx.lineCap  = "round";
    ctx.lineJoin = "round";

    // Outer soft glow
    ctx.globalAlpha = fade * 0.12;
    ctx.lineWidth   = 14;
    ctx.strokeStyle = primary;
    ctx.shadowColor = glow;
    ctx.shadowBlur  = 20;
    for (const chain of FINGER_CHAINS) drawSmoothChain(ctx, pts, chain);

    // Inner line
    ctx.globalAlpha = fade * 0.4;
    ctx.lineWidth   = 2.5;
    ctx.shadowBlur  = 6;
    if (isPinching || isDeleteMode) {
      ctx.strokeStyle = primary;
      for (const chain of FINGER_CHAINS) drawSmoothChain(ctx, pts, chain);
    } else {
      // Per-finger gradient
      for (const chain of FINGER_CHAINS) {
        const startPt = pts[chain[0]];
        const endPt   = pts[chain[chain.length - 1]];
        const grad    = ctx.createLinearGradient(startPt.x, startPt.y, endPt.x, endPt.y);
        grad.addColorStop(0, FINGER_COLORS[chain[0]] ?? primary);
        grad.addColorStop(1, FINGER_COLORS[chain[chain.length - 1]] ?? primary);
        ctx.strokeStyle = grad;
        drawSmoothChain(ctx, pts, chain);
      }
    }

    ctx.restore();
  }

  // ── Current frame: full skeleton + joints + crosshair ────────────────
  private drawCurrentFrame(
    ctx: CanvasRenderingContext2D,
    pts: Pt[],
    isPinching: boolean,
    isDeleteMode: boolean,
  ) {
    const primary = isDeleteMode ? "#ff2244" : isPinching ? "#ff00cc" : "#00ffe5";
    const glow    = isDeleteMode ? "#ff0000" : isPinching ? "#ff00ff" : "#00ffdd";

    ctx.save();
    ctx.lineCap  = "round";
    ctx.lineJoin = "round";

    // ── Pass A: Wide outer glow ───────────────────────────────────────
    ctx.globalAlpha = 0.20;
    ctx.lineWidth   = 20;
    ctx.strokeStyle = primary;
    ctx.shadowColor = glow;
    ctx.shadowBlur  = 28;
    for (const chain of FINGER_CHAINS) drawSmoothChain(ctx, pts, chain);

    // ── Pass B: Mid glow ─────────────────────────────────────────────
    ctx.globalAlpha = 0.50;
    ctx.lineWidth   = 7;
    ctx.shadowBlur  = 14;
    for (const chain of FINGER_CHAINS) drawSmoothChain(ctx, pts, chain);

    // ── Pass C: Bright crisp inner line (per-finger gradient) ────────
    ctx.globalAlpha = 1;
    ctx.lineWidth   = 2;
    ctx.shadowBlur  = 0;
    if (isPinching || isDeleteMode) {
      ctx.strokeStyle = primary;
      for (const chain of FINGER_CHAINS) drawSmoothChain(ctx, pts, chain);
    } else {
      for (const chain of FINGER_CHAINS) {
        const startPt = pts[chain[0]];
        const endPt   = pts[chain[chain.length - 1]];
        const grad    = ctx.createLinearGradient(startPt.x, startPt.y, endPt.x, endPt.y);
        grad.addColorStop(0, FINGER_COLORS[chain[0]] ?? primary);
        grad.addColorStop(1, FINGER_COLORS[chain[chain.length - 1]] ?? primary);
        ctx.strokeStyle = grad;
        drawSmoothChain(ctx, pts, chain);
      }
    }

    ctx.restore();

    // ── Joint dots ────────────────────────────────────────────────────
    for (let i = 0; i < pts.length; i++) {
      const p         = pts[i];
      const isTip     = TIPS.has(i);
      const isKnuckle = KNUCKLES.has(i);
      const isWrist   = i === 0;
      const dotColor  = isDeleteMode
        ? "#ff2244"
        : isPinching
        ? "#ff00cc"
        : FINGER_COLORS[i] ?? primary;
      const r = isTip ? 8 : isWrist ? 9 : isKnuckle ? 5.5 : 3.5;

      // Outer halo
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 11, 0, Math.PI * 2);
      ctx.fillStyle   = dotColor;
      ctx.globalAlpha = 0.10;
      ctx.shadowColor = dotColor;
      ctx.shadowBlur  = 22;
      ctx.fill();
      ctx.restore();

      // Mid glow
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      ctx.fillStyle   = dotColor;
      ctx.globalAlpha = 0.22;
      ctx.shadowColor = dotColor;
      ctx.shadowBlur  = 14;
      ctx.fill();
      ctx.restore();

      // Solid core
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle   = dotColor;
      ctx.globalAlpha = 0.95;
      ctx.shadowColor = dotColor;
      ctx.shadowBlur  = 10;
      ctx.fill();
      ctx.restore();

      // White centre
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.38, 0, Math.PI * 2);
      ctx.fillStyle   = "rgba(255,255,255,0.95)";
      ctx.shadowBlur  = 0;
      ctx.fill();
      ctx.restore();
    }

    // ── Fingertip accent rings ────────────────────────────────────────
    for (const ti of TIPS) {
      const p   = pts[ti];
      const col = isDeleteMode ? "#ff2244" : isPinching ? "#ff00cc" : FINGER_COLORS[ti] ?? primary;
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
      ctx.strokeStyle = col;
      ctx.lineWidth   = 1.2;
      ctx.globalAlpha = 0.7;
      ctx.shadowColor = col;
      ctx.shadowBlur  = 12;
      ctx.stroke();
      ctx.restore();
    }

    // ── Index fingertip crosshair ─────────────────────────────────────
    const indexTip = pts[8];
    const crossSz  = 22;
    const crossCol = isDeleteMode ? "#ff2244" : "#ffffff";
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = crossCol;
    ctx.lineWidth   = 1;
    ctx.shadowColor = crossCol;
    ctx.shadowBlur  = 10;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(indexTip.x - crossSz, indexTip.y);
    ctx.lineTo(indexTip.x + crossSz, indexTip.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(indexTip.x, indexTip.y - crossSz);
    ctx.lineTo(indexTip.x, indexTip.y + crossSz);
    ctx.stroke();
    ctx.restore();

    // ── Pinch / delete indicator ─────────────────────────────────────
    if (isPinching || isDeleteMode) {
      const thumbTip = pts[4];
      const midX = (thumbTip.x + indexTip.x) / 2;
      const midY = (thumbTip.y + indexTip.y) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(midX, midY, 18, 0, Math.PI * 2);
      ctx.strokeStyle = isDeleteMode ? "#ff0022" : "#ff00cc";
      ctx.lineWidth   = 2;
      ctx.globalAlpha = 0.9;
      ctx.shadowColor = isDeleteMode ? "#ff0000" : "#ff00cc";
      ctx.shadowBlur  = 22;
      ctx.stroke();
      ctx.restore();
    }
  }
}
