import { useEffect, useRef, useState, useCallback } from "react";
import { HandTracker, HandData } from "../lib/handTracker";
import { BuildingScene } from "../lib/buildingScene";

type Mode = "orbit" | "build" | "pan" | "delete";

const HAND_CONNECTIONS: [number, number][] = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];

const FINGERTIPS = [4, 8, 12, 16, 20];

function drawOneHand(
  ctx: CanvasRenderingContext2D,
  hand: HandData,
  w: number,
  h: number,
  color: string,
) {
  if (!hand?.landmarks) return;

  const lm = hand.landmarks;
  const px = (i: number) => (1 - lm[i].x) * w;
  const py = (i: number) => lm[i].y * h;

  ctx.save();
  ctx.strokeStyle = `${color}88`;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = color;
  ctx.shadowBlur = 5;
  ctx.lineCap = "round";

  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(px(a), py(a));
    ctx.lineTo(px(b), py(b));
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.fillStyle = `${color}bb`;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;

  for (const i of FINGERTIPS) {
    ctx.beginPath();
    ctx.arc(px(i), py(i), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

export default function HandWaveExperience() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const threeCanvasRef = useRef<HTMLCanvasElement>(null);
  const handDrawRef = useRef<HTMLCanvasElement>(null);
  const mediapipeCanvas = useRef<HTMLCanvasElement>(null);

  const sceneRef = useRef<BuildingScene | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const handsRef = useRef<HandData[]>([]);

  const [status, setStatus] = useState<"loading" | "tracking" | "error">("loading");

  const onHandData = useCallback((hands: HandData[]) => {
    handsRef.current = hands;
    sceneRef.current?.updateHands(hands);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const video = videoRef.current;
      const threeC = threeCanvasRef.current;
      const handC = handDrawRef.current;
      const mpC = mediapipeCanvas.current;

      if (!video || !threeC || !handC || !mpC) return;

      let scene: BuildingScene;

      try {
        scene = new BuildingScene(threeC);
      } catch {
        setStatus("error");
        return;
      }

      sceneRef.current = scene;
      setStatus("tracking");

      let tracker: HandTracker;

      const animate = () => {
        if (cancelled) return;

        scene.render();

        const ctx = handC.getContext("2d");
        if (ctx) {
          handC.width = handC.clientWidth;
          handC.height = handC.clientHeight;

          ctx.clearRect(0, 0, handC.width, handC.height);

          for (const h of handsRef.current) {
            drawOneHand(ctx, h, handC.width, handC.height, "#00c8ff");
          }
        }

        requestAnimationFrame(animate);
      };

      animate();

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });

        if (cancelled) return;

        video.srcObject = stream;
        await video.play();

        tracker = new HandTracker(video, mpC, onHandData);
        trackerRef.current = tracker;

        await tracker.init();
      } catch (err) {
        console.error(err);
        setStatus("error");
      }
    }

    init();

    return () => {
      cancelled = true;
      trackerRef.current?.destroy();
      sceneRef.current?.destroy();
    };
  }, [onHandData]);

  return (
    <div style={{ width: "100vw", height: "100vh", background: "black" }}>

      <video
        ref={videoRef}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: "scaleX(-1)",
        }}
        muted
        playsInline
      />

      <canvas ref={threeCanvasRef} style={{ position: "absolute" }} />
      <canvas ref={handDrawRef} style={{ position: "absolute" }} />
      <canvas ref={mediapipeCanvas} style={{ display: "none" }} />

      {status === "loading" && (
        <div style={{ color: "white", position: "absolute" }}>
          Loading...
        </div>
      )}

      {status === "error" && (
        <div style={{ color: "red", position: "absolute" }}>
          Camera error
        </div>
      )}
    </div>
  );
}
