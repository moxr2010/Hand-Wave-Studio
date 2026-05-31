import { Hands, Results, NormalizedLandmarkList } from "@mediapipe/hands";
import { Camera } from "@mediapipe/camera_utils";

export interface HandData {
  /** "Left" or "Right" as reported by MediaPipe (camera perspective) */
  label: "Left" | "Right";
  /** Normalised [0,1] index MCP position — stable pointer */
  x: number;
  y: number;
  depth: number;
  /** 👌 Thumb + index close together */
  isPinching:    boolean;
  pinchStrength: number;
  /** ✋ All four fingers extended above their lower joints */
  isOpen:   boolean;
  openness: number;
  /** ✊ All fingers curled, not pinching */
  isFist:   boolean;
  speed:    number;
  /** Smoothed MediaPipe landmarks */
  landmarks: NormalizedLandmarkList;
}

// ── Per-landmark low-pass filter ──────────────────────────────────────────────
const ALPHA_XY = 0.35;
const ALPHA_Z  = 0.10;
const DZ_XY    = 0.004;
const DZ_Z     = 0.002;

interface SmoothLm { x: number; y: number; z: number }

export class HandTracker {
  private hands:   Hands;
  private camera:  Camera;
  private onHands: (hands: HandData[]) => void;

  // Per-label smoothing state (keyed by "Left" | "Right")
  private smoothedLmMap = new Map<string, SmoothLm[]>();
  private lastXMap      = new Map<string, number>();
  private lastYMap      = new Map<string, number>();
  private lastTimeMap   = new Map<string, number>();

  constructor(
    video: HTMLVideoElement,
    _overlayCanvas: HTMLCanvasElement,
    onHands: (hands: HandData[]) => void,
  ) {
    this.onHands = onHands;

    this.hands = new Hands({
      locateFile: (file: string) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });

    this.hands.setOptions({
      maxNumHands:            2,
      modelComplexity:        1,
      minDetectionConfidence: 0.72,
      minTrackingConfidence:  0.65,
    });

    this.hands.onResults(this.handleResults.bind(this));

    this.camera = new Camera(video, {
      onFrame: async () => { await this.hands.send({ image: video }); },
      width:  1280,
      height: 720,
    });
  }

  async init() { await this.camera.start(); }
  detect()     { /* driven by camera callback */ }
  destroy()    { this.camera.stop(); this.hands.close(); }

  private handleResults(results: Results) {
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      this.smoothedLmMap.clear();
      this.onHands([]);
      return;
    }

    const out: HandData[] = [];

    results.multiHandLandmarks.forEach((raw, i) => {
      const handedness = results.multiHandedness?.[i];
      const label = (handedness?.label ?? "Left") as "Left" | "Right";

      // ── Per-hand low-pass landmark smoothing ───────────────────────────────
      let smoothed = this.smoothedLmMap.get(label);
      if (!smoothed) {
        smoothed = raw.map(l => ({ x: l.x, y: l.y, z: l.z ?? 0 }));
        this.smoothedLmMap.set(label, smoothed);
      } else {
        for (let j = 0; j < raw.length; j++) {
          const r = raw[j];
          const s = smoothed[j];
          const dx = r.x - s.x;
          const dy = r.y - s.y;
          const dz = (r.z ?? 0) - s.z;
          if (Math.abs(dx) > DZ_XY) s.x += dx * ALPHA_XY;
          if (Math.abs(dy) > DZ_XY) s.y += dy * ALPHA_XY;
          if (Math.abs(dz) > DZ_Z)  s.z += dz * ALPHA_Z;
        }
      }

      const lm = smoothed;

      // ── Hand size ──────────────────────────────────────────────────────────
      const wrist   = lm[0];
      const pointer = lm[5]; // index MCP
      const handSize = Math.sqrt(
        (pointer.x - wrist.x) ** 2 + (pointer.y - wrist.y) ** 2,
      );
      const depth = Math.max(0, Math.min(1, handSize * 4));

      // ── 👌 PINCH ───────────────────────────────────────────────────────────
      const thumbTip = lm[4];
      const indexTip = lm[8];
      const pinchD2D = Math.sqrt(
        (thumbTip.x - indexTip.x) ** 2 + (thumbTip.y - indexTip.y) ** 2,
      );
      const isPinching    = pinchD2D < 0.04;
      const pinchStrength = Math.max(0, 1 - pinchD2D / 0.04);

      // ── ✋ OPEN HAND — all four fingers extended above their lower joint ────
      // Matches the reference: lm[8].y < lm[6].y, etc.
      const isOpen =
        lm[8].y  < lm[6].y  &&   // index tip above PIP
        lm[12].y < lm[10].y &&   // middle tip above PIP
        lm[16].y < lm[14].y &&   // ring tip above PIP
        lm[20].y < lm[18].y;     // pinky tip above PIP

      const openness = this.calcOpenness(lm, handSize);

      // ── ✊ FIST ─────────────────────────────────────────────────────────────
      const isFist = openness < 0.20 && !isPinching;

      // ── Speed ──────────────────────────────────────────────────────────────
      const now  = performance.now();
      const last = this.lastTimeMap.get(label) ?? now;
      const dt   = Math.max(1, now - last);
      const lx   = this.lastXMap.get(label) ?? pointer.x;
      const ly   = this.lastYMap.get(label) ?? pointer.y;
      const vx   = (pointer.x - lx) / dt * 1000;
      const vy   = (pointer.y - ly) / dt * 1000;
      const speed = Math.min(1, Math.sqrt(vx * vx + vy * vy));
      this.lastXMap.set(label, pointer.x);
      this.lastYMap.set(label, pointer.y);
      this.lastTimeMap.set(label, now);

      out.push({
        label,
        x: 1 - pointer.x,
        y: pointer.y,
        depth,
        isPinching,
        pinchStrength,
        isOpen,
        openness,
        isFist,
        speed,
        landmarks: lm as unknown as NormalizedLandmarkList,
      });
    });

    // Remove smoothing state for hands that disappeared
    const activeLabels = new Set<string>(out.map(h => h.label));
    for (const k of this.smoothedLmMap.keys()) {
      if (!activeLabels.has(k)) this.smoothedLmMap.delete(k);
    }

    this.onHands(out);
  }

  private calcOpenness(lm: SmoothLm[], handSize: number): number {
    const tipIdx  = [4, 8, 12, 16, 20];
    const baseIdx = [2, 5, 9,  13, 17];
    let extended  = 0;
    for (let i = 0; i < 5; i++) {
      if (lm[tipIdx[i]].y < lm[baseIdx[i]].y - handSize * 0.08) extended++;
    }
    return extended / 5;
  }
}
