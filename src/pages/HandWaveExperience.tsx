import { useEffect, useRef, useState, useCallback } from "react";
import { HandTracker, HandData } from "../lib/handTracker";
import { BuildingScene } from "../lib/buildingScene";

export default function HandWaveExperience() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const threeRef = useRef<HTMLCanvasElement>(null);
  const handRef = useRef<HTMLCanvasElement>(null);
  const mpRef = useRef<HTMLCanvasElement>(null);

  const sceneRef = useRef<BuildingScene | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const handsRef = useRef<HandData[]>([]);

  const [status, setStatus] = useState("loading");

  const onHands = useCallback((hands: HandData[]) => {
    handsRef.current = hands;
    sceneRef.current?.updateHands(hands);
  }, []);

  useEffect(() => {
    let running = true;

    async function start() {
      try {
        const video = videoRef.current!;
        const canvas = threeRef.current!;
        const handCanvas = handRef.current!;
        const mpCanvas = mpRef.current!;

        // 🔥 resize FIX
        const resize = () => {
          canvas.width = window.innerWidth;
          canvas.height = window.innerHeight;
          handCanvas.width = window.innerWidth;
          handCanvas.height = window.innerHeight;
        };
        resize();
        window.addEventListener("resize", resize);

        // scene
        const scene = new BuildingScene(canvas);
        sceneRef.current = scene;

        // camera
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });

        video.srcObject = stream;
        await video.play();

        // tracker
        const tracker = new HandTracker(video, mpCanvas, onHands);
        trackerRef.current = tracker;
        await tracker.init();

        setStatus("tracking");

        // 🔥 main loop (IMPORTANT FIX)
        const loop = () => {
          if (!running) return;

          scene.render();

          requestAnimationFrame(loop);
        };

        loop();
      } catch (err) {
        console.error("INIT ERROR:", err);
        setStatus("error");
      }
    }

    start();

    return () => {
      running = false;
      trackerRef.current?.destroy();
      sceneRef.current?.destroy();
    };
  }, [onHands]);

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      {/* video */}
      <video
        ref={videoRef}
        muted
        playsInline
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: "scaleX(-1)",
        }}
      />

      {/* 3D */}
      <canvas ref={threeRef} style={{ position: "absolute", inset: 0 }} />

      {/* overlay */}
      <canvas ref={handRef} style={{ position: "absolute", inset: 0 }} />

      {/* hidden mediapipe */}
      <canvas ref={mpRef} style={{ display: "none" }} />

      {status === "loading" && (
        <div style={{ color: "white", position: "absolute" }}>
          Loading camera...
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
