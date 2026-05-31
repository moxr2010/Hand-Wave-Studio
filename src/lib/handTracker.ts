import { Hands, Results, NormalizedLandmarkList } from "@mediapipe/hands";
import { Camera } from "@mediapipe/camera_utils";

export interface HandData {
  label: "Left" | "Right";
  x: number;
  y: number;
  depth: number;

  isPinching: boolean;
  pinchStrength: number;

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
    await this.camera.start();
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

      const wrist = lm[0];
      const index = lm[8];
      const middle = lm[12];

      // ✨ مركز اليد الحقيقي
      const cx = (wrist.x + index.x + middle.x) / 3;
      const cy = (wrist.y + index.y + middle.y) / 3;

      // 🔥 تحويل نظيف للعالم
      const x = (cx - 0.5) * 3;
      const y = -(cy - 0.5) * 3;

      // depth = حجم اليد
      const handSize = Math.hypot(index.x - wrist.x, index.y - wrist.y);
      const depth = Math.min(1, handSize * 5);

      // pinch
      const pinch = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y);
      const isPinching = pinch < 0.05;
      const pinchStrength = Math.max(0, 1 - pinch / 0.05);

      out.push({
        label,
        x,
        y,
        depth,
        isPinching,
        pinchStrength,
        landmarks: lm,
      });
    });

    this.onHands(out);
  }
}
