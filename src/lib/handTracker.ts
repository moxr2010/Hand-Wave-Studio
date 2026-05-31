import { Hands, Results, NormalizedLandmarkList } from "@mediapipe/hands";
import { Camera } from "@mediapipe/camera_utils";

export interface HandData {
  label: "Left" | "Right";
  x: number;
  y: number;
  depth: number;
  isPinching: boolean;
  pinchStrength: number;
  isOpen: boolean;
  openness: number;
  isFist: boolean;
  speed: number;
  landmarks: NormalizedLandmarkList;
}

const ALPHA_XY = 0.35;
const ALPHA_Z = 0.1;
const DZ_XY = 0.004;
const DZ_Z = 0.002;

interface SmoothLm {
  x: number;
  y: number;
  z: number;
}

export class HandTracker {
  private hands: Hands;
  private camera: Camera;
  private onHands: (hands: HandData[]) => void;

  private smoothedLmMap = new Map<string, SmoothLm[]>();
  private lastXMap = new Map<string, number>();
  private lastYMap = new Map<string, number>();
  private lastTimeMap = new Map<string, number>();

  constructor(
    video: HTMLVideoElement,
    _overlayCanvas: HTMLCanvasElement,
    onHands: (hands: HandData[]) => void
  ) {
    this.onHands = onHands;

    this.hands = new Hands({
      locateFile: (file: string) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });

    this.hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.6,
    });

    this.hands.onResults(this.handleResults.bind(this));

    this.camera = new Camera(video, {
      onFrame: async () => {
        await this.hands.send({ image: video });
      },
      width: 1280,
      height: 720,
    });
  }

  async init() {
    await this.camera.start();
  }

  detect() {
    // MediaPipe camera handles updates automatically
  }

  destroy() {
    this.camera.stop();
    this.hands.close();
  }

  private handleResults(results: Results) {
    if (!results.multiHandLandmarks?.length) {
      this.smoothedLmMap.clear();
      this.onHands([]);
      return;
    }

    const out: HandData[] = [];

    results.multiHandLandmarks.forEach((raw, i) => {
      const handedness = results.multiHandedness?.[i];
      const label = (handedness?.label ?? "Left") as "Left" | "Right";

      let smoothed = this.smoothedLmMap.get(label);

      if (!smoothed) {
        smoothed = raw.map((l) => ({ x: l.x, y: l.y, z: l.z ?? 0 }));
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
          if (Math.abs(dz) > DZ_Z) s.z += dz * ALPHA_Z;
        }
      }

      const lm = smoothed;

      const wrist = lm[0];
      const pointer = lm[5];

      const handSize = Math.hypot(
        pointer.x - wrist.x,
        pointer.y - wrist.y
      );

      const depth = Math.min(1, handSize * 4);

      const thumb = lm[4];
      const index = lm[8];

      const pinchD = Math.hypot(
        thumb.x - index.x,
        thumb.y - index.y
      );

      const isPinching = pinchD < 0.04;
      const pinchStrength = Math.max(0, 1 - pinchD / 0.04);

      const isOpen =
        lm[8].y < lm[6].y &&
        lm[12].y < lm[10].y &&
        lm[16].y < lm[14].y &&
        lm[20].y < lm[18].y;

      const openness = this.calcOpenness(lm, handSize);
      const isFist = openness < 0.2 && !isPinching;

      const now = performance.now();
      const last = this.lastTimeMap.get(label) ?? now;
      const dt = Math.max(1, now - last);

      const lx = this.lastXMap.get(label) ?? pointer.x;
      const ly = this.lastYMap.get(label) ?? pointer.y;

      const vx = (pointer.x - lx) / dt;
      const vy = (pointer.y - ly) / dt;

      const speed = Math.min(1, Math.hypot(vx, vy));

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

    this.onHands(out);
  }

  private calcOpenness(lm: SmoothLm[], handSize: number) {
    const tip = [4, 8, 12, 16, 20];
    const base = [2, 5, 9, 13, 17];

    let open = 0;

    for (let i = 0; i < 5; i++) {
      if (lm[tip[i]].y < lm[base[i]].y - handSize * 0.08) {
        open++;
      }
    }

    return open / 5;
  }
}
