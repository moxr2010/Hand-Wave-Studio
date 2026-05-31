import { useEffect, useRef, useState, useCallback } from "react";
import { HandTracker, HandData } from "@/lib/handTracker";
import { BuildingScene } from "@/lib/buildingScene";

type Mode = "orbit" | "build" | "pan" | "delete";

// Connections between MediaPipe hand landmark indices
const HAND_CONNECTIONS: [number, number][] = [
  [0,1],[1,2],[2,3],[3,4],          // thumb
  [0,5],[5,6],[6,7],[7,8],          // index
  [0,9],[9,10],[10,11],[11,12],     // middle
  [0,13],[13,14],[14,15],[15,16],   // ring
  [0,17],[17,18],[18,19],[19,20],   // pinky
  [5,9],[9,13],[13,17],             // palm knuckle bar
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

  // Mirror X to match the flipped video
  const px = (i: number) => (1 - lm[i].x) * w;
  const py = (i: number) =>  lm[i].y       * h;

  // ── Skeleton connections ─────────────────────────────────
  ctx.save();
  ctx.strokeStyle = `${color}88`;
  ctx.lineWidth   = 1.5;
  ctx.shadowColor = color;
  ctx.shadowBlur  = 5;
  ctx.lineCap     = "round";

  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(px(a), py(a));
    ctx.lineTo(px(b), py(b));
    ctx.stroke();
  }
  ctx.restore();

  // ── Fingertip dots ────────────────────────────────────────
  ctx.save();
  ctx.fillStyle   = `${color}bb`;
  ctx.shadowColor = color;
  ctx.shadowBlur  = 8;
  for (const i of FINGERTIPS) {
    ctx.beginPath();
    ctx.arc(px(i), py(i), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = `${color}88`;
  ctx.beginPath();
  ctx.arc(px(0), py(0), 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ── Pinch indicator ───────────────────────────────────────
  if (hand.pinchStrength > 0.35) {
    const mx     = (px(4) + px(8)) / 2;
    const my     = (py(4) + py(8)) / 2;
    const t      = hand.pinchStrength;
    const radius = 10 * (1 - t * 0.6) + 2;
    const alpha  = Math.min(1, t * 1.4);

    ctx.save();
    ctx.strokeStyle = `${color}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
    ctx.lineWidth   = 1.8;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 14;
    ctx.beginPath();
    ctx.arc(mx, my, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

export default function HandWaveExperience() {
  const videoRef        = useRef<HTMLVideoElement>(null);
  const mediapipeCanvas = useRef<HTMLCanvasElement>(null);
  const threeCanvasRef  = useRef<HTMLCanvasElement>(null);
  const handDrawRef     = useRef<HTMLCanvasElement>(null);

  const sceneRef     = useRef<BuildingScene | null>(null);
  const trackerRef   = useRef<HandTracker | null>(null);
  const handsRef     = useRef<HandData[]>([]);
  const animFrameRef = useRef<number>(0);

  const [status, setStatus]         = useState<"loading" | "tracking" | "error">("loading");
  const [showIntro, setShowIntro]   = useState(true);
  const [mode, setMode]             = useState<Mode>("build");
  const [blockCount, setBlockCount] = useState(0);
  const introTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onHandData = useCallback((hands: HandData[]) => {
    handsRef.current = hands;
    sceneRef.current?.updateHands(hands);
    if (hands.length > 0 && showIntro) setShowIntro(false);
  }, [showIntro]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const video   = videoRef.current;
      const mpC     = mediapipeCanvas.current;
      const threeC  = threeCanvasRef.current;
      const handC   = handDrawRef.current;
      if (!video || !mpC || !threeC || !handC) return;

      let scene: BuildingScene;
      try {
        scene = new BuildingScene(threeC);
      } catch {
        if (!cancelled) setStatus("error");
        return;
      }
      sceneRef.current = scene;
      setStatus("tracking");

      let trackerReady = false;
      let tracker: HandTracker | null = null;

      function animate() {
        if (cancelled) return;
        if (trackerReady && tracker) tracker.detect();
        scene.render();

        // Draw hand overlay in 2-D on the dedicated canvas
        if (handC) {
          if (handC.width !== handC.clientWidth || handC.height !== handC.clientHeight) {
            handC.width  = handC.clientWidth;
            handC.height = handC.clientHeight;
          }
          const ctx = handC.getContext("2d");
          if (ctx) {
            ctx.clearRect(0, 0, handC.width, handC.height);
            for (const h of handsRef.current) {
              // Build hand (Left) = cyan, Control hand (Right) = purple
              const col = h.label === "Left" ? ACCENT : CONTROL_COLOR;
              drawOneHand(ctx, h, handC.width, handC.height, col);
            }
          }
        }

        // Sync HUD state
        const hands  = handsRef.current;
        const build  = hands.find(h => h.label === "Left");
        const ctrl   = hands.find(h => h.label === "Right");
        const isDel  = scene.isDeleteMode;
        let next: Mode = "build";
        if (ctrl?.isOpen)   next = "orbit";
        else if (isDel)     next = "delete";
        else if (build?.isPinching) next = "build";
        setMode(next);
        setBlockCount(scene.blockCount);

        animFrameRef.current = requestAnimationFrame(animate);
      }
      animate();

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, facingMode: "user" },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        video.srcObject = stream;
        await video.play();

        tracker = new HandTracker(video, mpC, onHandData);
        trackerRef.current = tracker;
        await tracker.init();
        if (cancelled) return;

        trackerReady = true;
        introTimerRef.current = setTimeout(() => setShowIntro(false), 7000);
      } catch (err) {
        console.error("Init error:", err);
        if (!cancelled) setStatus("error");
      }
    }

    init();

    return () => {
      cancelled = true;
      cancelAnimationFrame(animFrameRef.current);
      if (introTimerRef.current) clearTimeout(introTimerRef.current);
      trackerRef.current?.destroy();
      sceneRef.current?.destroy();
      const video = videoRef.current;
      if (video?.srcObject) {
        (video.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      }
    };
  }, [onHandData]);

  useEffect(() => {
    const handleResize = () => sceneRef.current?.resize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const modeLabel: Record<Mode, string> = {
    orbit:  "ORBIT",
    build:  "BUILD",
    pan:    "PAN",
    delete: "DELETE",
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden", userSelect: "none" }}>

      {/* Webcam background */}
      <video
        ref={videoRef}
        playsInline
        muted
        style={{
          position: "absolute", inset: 0,
          width: "100%", height: "100%",
          objectFit: "cover",
          transform: "scaleX(-1)",
        }}
      />

      {/* Three.js solid+wireframe cubes */}
      <canvas
        ref={threeCanvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      />

      {/* 2-D hand skeleton overlay — same cyan as cubes */}
      <canvas
        ref={handDrawRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      />

      {/* MediaPipe hidden processing canvas */}
      <canvas ref={mediapipeCanvas} style={{ display: "none" }} />

      {/* Loading */}
      {status === "loading" && (
        <div style={centeredOverlay}>
          <div style={spinner} />
          <p style={label}>Starting camera…</p>
        </div>
      )}

      {/* Error */}
      {status === "error" && (
        <div style={centeredOverlay}>
          <p style={{ ...label, color: ACCENT, fontSize: 16 }}>
            Camera or WebGL unavailable. Allow permissions and refresh.
          </p>
        </div>
      )}

      {/* Intro */}
      {status === "tracking" && showIntro && (
        <div style={{
          position: "absolute", inset: 0, pointerEvents: "none",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 28,
        }}>
          <p style={{
            ...label,
            fontSize: "clamp(16px, 2vw, 24px)",
            color: ACCENT,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            textShadow: `0 0 24px ${ACCENT}88`,
            animation: "fadeUp 0.7s ease both",
          }}>
            AR Wireframe Builder
          </p>

          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", justifyContent: "center", animation: "fadeUp 0.9s 0.2s ease both" }}>
            {([
              ["👌", "LEFT PINCH",  "Place cube",    ACCENT],
              ["✋", "RIGHT OPEN",  "Move + Rotate", CONTROL_COLOR],
            ] as const).map(([icon, act, desc, col]) => (
              <div key={act} style={{
                textAlign: "center", fontFamily: mono,
                padding: "12px 18px",
                border: `1px solid ${col}33`,
                borderRadius: 6,
                background: "rgba(0,0,0,0.5)",
                backdropFilter: "blur(8px)",
                minWidth: 110,
              }}>
                <div style={{ fontSize: 26, marginBottom: 8 }}>{icon}</div>
                <div style={{ fontSize: 11, color: col, letterSpacing: "0.1em" }}>{act}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>{desc}</div>
              </div>
            ))}
          </div>

          <p style={{ ...label, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.15em", animation: "fadeUp 0.9s 0.4s ease both" }}>
            SHOW YOUR HAND TO START
          </p>
        </div>
      )}

      {/* HUD */}
      {status === "tracking" && (
        <>
          {/* Mode — top center */}
          <div style={{
            position: "absolute", top: 20, left: "50%", transform: "translateX(-50%)",
            fontFamily: mono, fontSize: 11, letterSpacing: "0.22em",
            color: modeGlow[mode],
            textShadow: `0 0 14px ${modeGlow[mode]}`,
            padding: "5px 18px",
            border: `1px solid ${modeGlow[mode]}44`,
            borderRadius: 3,
            background: "rgba(0,0,0,0.45)",
            backdropFilter: "blur(6px)",
            pointerEvents: "none",
            transition: "color 0.2s, text-shadow 0.2s, border-color 0.2s",
          }}>
            {modeLabel[mode]}
          </div>

          {/* Block counter — top right */}
          <div style={{
            position: "absolute", top: 20, right: 22,
            fontFamily: mono, fontSize: 10, letterSpacing: "0.16em",
            color: ACCENT + "99",
            pointerEvents: "none",
          }}>
            {String(blockCount).padStart(3, "0")} CUBES
          </div>

          {/* Legend — bottom left */}
          <div style={{
            position: "absolute", bottom: 22, left: 22,
            fontFamily: mono, fontSize: 10, letterSpacing: "0.1em",
            color: "rgba(255,255,255,0.3)", lineHeight: 2,
            pointerEvents: "none",
          }}>
            <div><span style={{ color: ACCENT + "dd" }}>LEFT PINCH &nbsp;</span>→ place cube</div>
            <div><span style={{ color: CONTROL_COLOR + "dd" }}>RIGHT OPEN &nbsp;</span>→ move + rotate</div>
          </div>
        </>
      )}

      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(14px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

const ACCENT        = "#00c8ff";   // cyan  — build hand
const CONTROL_COLOR = "#a855f7";   // purple — control hand
const mono          = "'JetBrains Mono','Fira Code','Courier New',monospace";

const modeGlow: Record<"orbit" | "build" | "pan" | "delete", string> = {
  orbit:  "#00e5ff",
  build:  ACCENT,
  pan:    "#60a0ff",
  delete: "#ff5577",
};

const centeredOverlay: React.CSSProperties = {
  position: "absolute", inset: 0,
  display: "flex", flexDirection: "column",
  alignItems: "center", justifyContent: "center", gap: 14,
};

const spinner: React.CSSProperties = {
  width: 32, height: 32,
  border: `2px solid ${ACCENT}22`,
  borderTop: `2px solid ${ACCENT}`,
  borderRadius: "50%",
  animation: "spin 0.85s linear infinite",
};

const label: React.CSSProperties = {
  fontFamily: mono, fontSize: 13,
  color: `${ACCENT}99`, letterSpacing: "0.1em",
  margin: 0,
};
