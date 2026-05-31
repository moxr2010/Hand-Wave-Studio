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

export class HandTracker {
  private hands: Hands;
  private camera: Camera;
  private onHands: (hands: HandData[]) => void;

  private lastX = new Map<string, number>();
  private lastY = new Map<string, number>();
  private lastT = new Map<string, number>();

  constructor(
    video: HTMLVideoElement,
    _canvas: HTMLCanvasElement,
    onHands: (hands: HandData[]) => void
  ) {
    this.onHands = onHands;

    this.hands = new Hands({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });

    this.hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.7,
    });

    this.hands.onResults(this.onResults.bind(this));

    this.camera = new Camera(video, {
      width: 1280,
      height: 720,
      onFrame: async () => {
        await this.hands.send({ image: video });
      },
    });
  }

  async init() {
    try {
      await this.camera.start();
      console.log("✅ camera started");
    } catch (e) {
      console.error("❌ CAMERA FAILED:", e);
    }
  }

  destroy() {
    this.camera.stop();
    this.hands.close();
  }

  private onResults(results: Results) {
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      this.onHands([]);
      return;
    }

    const out: HandData[] = [];

    results.multiHandLandmarks.forEach((lm, i) => {
      const handed = results.multiHandedness?.[i]?.label;

      const label: "Left" | "Right" =
        handed === "Right" ? "Right" : "Left";

      const thumb = lm[4];
      const index = lm[8];

      // 🤏 pinch
      const pinchDist = Math.hypot(
        thumb.x - index.x,
        thumb.y - index.y
      );

      const isPinching = pinchDist < 0.05;
      const pinchStrength = Math.max(0, 1 - pinchDist / 0.05);

      // 📏 depth
      const wrist = lm[0];
      const mid = lm[5];

      const depth = Math.min(
        1,
        Math.hypot(mid.x - wrist.x, mid.y - wrist.y) * 4
      );

      // 🖱️ position (fixed mirror)
      const x = (index.x - 0.5) * 2;
      const y = -(index.y - 0.5) * 2;

      // ⚡ speed
      const now = performance.now();
      const last = this.lastT.get(label) ?? now;
      const dt = Math.max(1, now - last);

      const lx = this.lastX.get(label) ?? x;
      const ly = this.lastY.get(label) ?? y;

      const speed = Math.min(
        1,
        Math.hypot(x - lx, y - ly) / dt * 1000
      );

      this.lastX.set(label, x);
      this.lastY.set(label, y);
      this.lastT.set(label, now);

      // ✋ open hand (simple but reliable)
      const isOpen =
        lm[8].y < lm[6].y &&
        lm[12].y < lm[10].y &&
        lm[16].y < lm[14].y &&
        lm[20].y < lm[18].y;

      const openness =
        [8, 12, 16, 20].filter(i => lm[i].y < lm[i - 2].y).length / 4;

      const isFist = openness < 0.25 && !isPinching;

      out.push({
        label,
        x,
        y,
        depth,
        isPinching,
        pinchStrength,
        isOpen,
        openness,
        isFist,
        speed,
        landmarks: lm,
      });
    });

    this.onHands(out);
  }
}
