import { useEffect, useRef, useState, useCallback } from "react";
import { HandTracker, HandData } from "../lib/handTracker";
import { ParticleScene } from "../lib/particleScene";

export default function HandWaveExperience() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const trackerRef = useRef<HandTracker | null>(null);
  const sceneRef = useRef<ParticleScene | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const currentHand = useRef<HandData | null>(null);

  const onHands = useCallback((hands: HandData[]) => {
    currentHand.current = hands.length > 0 ? hands[0] : null;
    sceneRef.current?.updateHand(currentHand.current);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (!video || !canvas) return;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });

        if (cancelled) return;

        video.srcObject = stream;
        await video.play();

        // Scene
        const scene = new ParticleScene(canvas);
        sceneRef.current = scene;

        // Tracker
        const tracker = new HandTracker(video, canvas, onHands);
        trackerRef.current = tracker;

        await tracker.init();

        setStatus("ready");

        const animate = () => {
          if (cancelled) return;

          scene.render();
          requestAnimationFrame(animate);
        };

        animate();
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

      const video = videoRef.current;
      if (video?.srcObject) {
        (video.srcObject as MediaStream)
          .getTracks()
          .forEach((t) => t.stop());
      }
    };
  }, [onHands]);

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

      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
        }}
      />

      {status === "loading" && (
        <div style={{ color: "white", position: "absolute", top: 20, left: 20 }}>
          Loading camera...
        </div>
      )}

      {status === "error" && (
        <div style={{ color: "red", position: "absolute", top: 20, left: 20 }}>
          Camera error
        </div>
      )}
    </div>
  );
}
