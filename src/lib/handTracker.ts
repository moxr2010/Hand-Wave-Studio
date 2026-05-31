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
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6,
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
      console.log("camera started");
    } catch (e) {
      console.error("CAMERA FAILED:", e);
    }
  }

  destroy() {
    this.camera.stop();
    this.hands.close();
  }

  private onResults(results: Results) {
    if (!results.multiHandLandmarks?.length) {
      this.onHands([]);
      return;
    }

    const out: HandData[] = [];

    results.multiHandLandmarks.forEach((lm, i) => {
      const label =
        results.multiHandedness?.[i]?.label === "Right" ? "Right" : "Left";

      const thumb = lm[4];
      const index = lm[8];

      const pinch = Math.hypot(thumb.x - index.x, thumb.y - index.y);
      const isPinching = pinch < 0.045;

      const wrist = lm[0];
      const mc = lm[5];

      const depth = Math.min(
        1,
        Math.hypot(mc.x - wrist.x, mc.y - wrist.y) * 4
      );

      const x = 1 - index.x;
      const y = index.y;

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

      out.push({
        label,
        x,
        y,
        depth,
        isPinching,
        pinchStrength: 0,
        isOpen: false,
        openness: 0,
        isFist: false,
        speed,
        landmarks: lm,
      });
    });

    this.onHands(out);
  }
}
