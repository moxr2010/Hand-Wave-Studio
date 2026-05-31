import * as THREE from "three";
import { HandData } from "./handTracker";

// ── Constants ─────────────────────────────────────────────────────────────

const CELL        = 0.2;         // grid unit size (world units) — small, detailed cubes
const BOUNDS      = 30;          // ± max grid index on any axis (30 × 0.2 = 6 world units)
const TAP_FRAMES  = 12;          // frames  ≈ 200 ms — short pinch = tap, long = hold
const HOLD_FRAMES = 55;          // frames ≈ 900 ms — sustained hold triggers delete mode
const WIRE_COLOR  = 0x00c8ff;   // soft cyan-blue

// Fixed projection depth — keeps cubes at a stable distance so apparent
// size never changes with hand size fluctuation
const BUILD_DEPTH = 6.0;

// Smoothing pipeline
const SCREEN_SMOOTH = 0.22;      // lerp factor for screen-space landmark positions
const WORLD_SMOOTH  = 0.16;      // lerp factor for 3-D world position
const DEAD_ZONE     = 0.016;     // world units — ignore hand trembles below this (≈ CELL/12)

// Continuous drawing
const RESET_DISTANCE  = 1.2;     // world units — if hand drifts this far, start fresh struct

// Camera damping
const ORBIT_DECAY  = 0.88;
const ORBIT_DRAG   = 0.80;
const ORBIT_SENS_H = 0.014;   // radians per normalised hand-delta unit (quaternion)
const ORBIT_SENS_V = 0.010;
const PAN_SENS     = 0.06;
const PAN_DECAY    = 0.88;

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * 3-D DDA line tracer.
 *
 * Returns the ordered list of grid cells (as integer [gx,gy,gz] triples)
 * that lie on the straight line from `from` to `to` in world space,
 * NOT including the `from` cell itself (only the new cells to visit).
 *
 * This lets the HOLD mode fill every grid cell the hand passes through
 * between frames, so fast movement never skips cubes.
 */
function gridLineTo(
  from: THREE.Vector3,
  to:   THREE.Vector3,
): [number, number, number][] {
  const x0 = Math.round(from.x / CELL);
  const y0 = Math.round(from.y / CELL);
  const z0 = Math.round(from.z / CELL);
  const x1 = Math.round(to.x   / CELL);
  const y1 = Math.round(to.y   / CELL);
  const z1 = Math.round(to.z   / CELL);

  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  if (steps === 0) return [];

  const out: [number, number, number][] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    out.push([
      Math.round(x0 + (x1 - x0) * t),
      Math.round(y0 + (y1 - y0) * t),
      Math.round(z0 + (z1 - z0) * t),
    ]);
  }
  return out;
}

function key3(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

// ── Types ─────────────────────────────────────────────────────────────────

interface CubeEntry { group: THREE.Group }

// ── Main class ────────────────────────────────────────────────────────────

export class BuildingScene {
  private renderer!: THREE.WebGLRenderer;
  private scene:  THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private width:  number;
  private height: number;

  // ── Camera ────────────────────────────────────────────────
  private camRadius = 6;
  private camTarget = new THREE.Vector3(0, 0.4, 0);

  /**
   * Quaternion that rotates the base offset (0, 0, camRadius) to the
   * current camera position relative to camTarget.
   * Initialised to match the old spherical start: theta=PI*0.25, phi=1.05
   */
  private camQuat = (() => {
    const initDir = new THREE.Vector3(
      Math.sin(1.05) * Math.sin(Math.PI * 0.25),
      Math.cos(1.05),
      Math.sin(1.05) * Math.cos(Math.PI * 0.25),
    ).normalize();
    return new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      initDir,
    );
  })();

  // Angular velocity (radians/frame) driving quaternion increments
  private velH    = 0;   // yaw   (rotation around world Y)
  private velV    = 0;   // pitch (rotation around camera local X)
  private velPanX = 0;
  private velPanY = 0;

  // ── Grid ──────────────────────────────────────────────────
  private occupied = new Set<string>();
  private cubesMap = new Map<string, CubeEntry>();

  // ── Gesture state ─────────────────────────────────────────
  /** Left hand  → build (pinch to place cubes) */
  private buildHand:   HandData | null = null;
  /** Right hand → control (open hand: delta move + rotate) */
  private controlHand: HandData | null = null;
  /** Previous palm position of the control hand — used to compute delta */
  private prevControlX = 0;
  private prevControlY = 0;
  /** Whether prevControl has been seeded for the current open-hand stroke */
  private controlSeeded = false;
  /** Palm Y of previous frame during right-hand pinch zoom — null when not zooming */
  private prevZoomY: number | null = null;

  private prevHandX = -1;
  private prevHandY = -1;
  private wasPinching = false;
  private pinchFrames = 0;
  private _deleteMode = false;
  /**
   * true once pinch has been held past TAP_FRAMES.
   * While false the gesture is still "undecided" (tap window open).
   * Set to false again on every release.
   */
  private holdMode = false;

  /**
   * World-space position of the most recently placed cube.
   * Persists across pinch strokes so the next stroke continues the structure.
   * null = no cube placed yet (next pinch starts fresh).
   */
  private lastCubePos: THREE.Vector3 | null = null;

  // ── Smoothing state ───────────────────────────────────────
  private smoothMx = -1;       // screen-space pinch X (smoothed) — kept for compatibility
  private smoothMy = -1;       // screen-space pinch Y (smoothed)
  private smoothWorldPos:  THREE.Vector3 | null = null;
  /**
   * Exponentially-smoothed wrist→fingertip unit vector in world space.
   * Replaces the fixed-depth screen raycaster: the finger's 3-D orientation
   * is the draw direction, so tilting toward the screen → depth movement,
   * sideways → lateral, up/down → vertical.
   */
  private smoothFingerDir: THREE.Vector3 | null = null;

  // ── Cursor (directional controller) ───────────────────────
  /**
   * Accumulated 3-D cursor position driven by hand movement deltas.
   * Starts at scene centre; moves by (current − previous) finger world pos
   * every frame, giving "joystick" feel — the hand controls direction and
   * speed, not absolute position.
   */
  private cursorPos    = new THREE.Vector3(0, 0, 0);
  /** Previous frame's smoothed finger world pos — used to compute delta. */
  private prevWorldPos: THREE.Vector3 | null = null;
  /** Ghost cube mesh sitting at the snapped cursor position. */
  private cursorMesh!: THREE.Group;

  // ── Structure group (MOVE MODE) ────────────────────────────
  /** All placed cubes live inside this group so they can move together. */
  private cubesGroup!: THREE.Group;
  /** Accumulated object rotation (full 360°, no clamping). */
  private groupRotX    = 0;
  private groupRotY    = 0;

  // ── Exposed state ─────────────────────────────────────────
  get isDeleteMode(): boolean { return this._deleteMode; }
  get blockCount():   number  { return this.occupied.size; }

  // ── Construction ──────────────────────────────────────────

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.width  = window.innerWidth;
    this.height = window.innerHeight;
    this.initRenderer();
    this.scene  = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, this.width / this.height, 0.1, 300);
    this.initLights();
    this.cubesGroup = new THREE.Group();
    this.scene.add(this.cubesGroup);
    this.initCursor();
    this.syncCamera();
  }

  /**
   * Creates the ghost cursor cube — always visible, sits at the snapped
   * cursor position so the user can see where the next pinch will land.
   * Brighter wireframe + no solid fill to distinguish it from placed cubes.
   */
  private initCursor() {
    const geo     = new THREE.BoxGeometry(CELL, CELL, CELL);
    const glowGeo = new THREE.BoxGeometry(CELL * 1.15, CELL * 1.15, CELL * 1.15);

    this.cursorMesh = new THREE.Group();

    // Dim solid fill — just enough to read depth
    this.cursorMesh.add(new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
      color:       0x003a55,
      emissive:    0x001020,
      specular:    WIRE_COLOR,
      transparent: true,
      opacity:     0.18,
      side:        THREE.DoubleSide,
      depthWrite:  false,
    })));

    // Bright wireframe so it pops against the scene
    this.cursorMesh.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color:       WIRE_COLOR,
      wireframe:   true,
      transparent: true,
      opacity:     1.0,
    })));

    // Additive glow halo — pulses with Three.js clock in update
    this.cursorMesh.add(new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({
      color:      WIRE_COLOR,
      transparent: true,
      opacity:     0.22,
      side:        THREE.BackSide,
      blending:    THREE.AdditiveBlending,
      depthWrite:  false,
    })));

    // Parent to cubesGroup so the cursor lives in group-local space
    // and rotates / translates with the structure automatically.
    this.cubesGroup.add(this.cursorMesh);
  }

  private initLights() {
    // Soft ambient so faces on all sides get base illumination
    this.scene.add(new THREE.AmbientLight(0x8ab4f8, 0.55));

    // Main key light — warm-white from upper-right-front
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2, 3, 2);
    this.scene.add(key);

    // Cool fill light from opposite side — adds depth contrast
    const fill = new THREE.DirectionalLight(0x004488, 0.6);
    fill.position.set(-2, -1, -2);
    this.scene.add(fill);

    // Subtle rim light from below — lifts the base faces
    const rim = new THREE.DirectionalLight(0x002255, 0.3);
    rim.position.set(0, -2, 1);
    this.scene.add(rim);
  }

  private initRenderer() {
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas, antialias: true,
        alpha: true, premultipliedAlpha: false,
        powerPreference: "high-performance",
      });
    } catch {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas, antialias: false,
        alpha: true, premultipliedAlpha: false,
      });
    }
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
  }

  private syncCamera() {
    // Rotate the base offset (0, 0, radius) by the accumulated quaternion.
    // No angle clamping — the quaternion can represent any orientation freely.
    const offset = new THREE.Vector3(0, 0, this.camRadius)
      .applyQuaternion(this.camQuat);
    this.camera.position.copy(this.camTarget).add(offset);
    this.camera.lookAt(this.camTarget);
    this.camera.updateProjectionMatrix();
  }

  // ── Public API ────────────────────────────────────────────

  /** Route incoming hands by label. Left = build, Right = control. */
  updateHands(hands: HandData[]) {
    this.buildHand   = hands.find(h => h.label === "Left")  ?? null;
    this.controlHand = hands.find(h => h.label === "Right") ?? null;
  }

  // ── Render loop ───────────────────────────────────────────

  render() {
    // ── RIGHT HAND → CONTROL ─────────────────────────────────────────────
    //
    //   PINCH  → ZOOM:  delta palmY drives uniform scale (clamped 0.3 – 3)
    //   OPEN   → MOVE + ROTATE: delta palm position drives both simultaneously
    //
    if (this.controlHand) {
      const palm = this.controlHand.landmarks[0];
      const px   = palm.x - 0.5;
      const py   = palm.y - 0.5;

      if (this.controlHand.isPinching) {
        // ── 🤏 ZOOM MODE — right-hand pinch ──────────────────────────────
        if (this.prevZoomY !== null) {
          const deltaY   = py - this.prevZoomY;
          const ZOOM_SPD = 3;
          let s = this.cubesGroup.scale.x + -deltaY * ZOOM_SPD;
          s = Math.max(0.3, Math.min(3, s));
          this.cubesGroup.scale.setScalar(s);
        }
        this.prevZoomY     = py;
        this.controlSeeded = false;   // reset move seed when zooming

      } else {
        // ── ✋ MOVE + ROTATE — right-hand open ────────────────────────────
        this.prevZoomY = null;

        if (!this.controlSeeded) {
          this.prevControlX  = px;
          this.prevControlY  = py;
          this.controlSeeded = true;
        }

        const dx = px - this.prevControlX;
        const dy = py - this.prevControlY;

        this.cubesGroup.position.x += dx * 2;
        this.cubesGroup.position.y += -dy * 2;

        this.groupRotY += dx * 3;
        this.groupRotX += dy * 3;
        this.cubesGroup.rotation.set(this.groupRotX, this.groupRotY, 0);

        this.prevControlX = px;
        this.prevControlY = py;
      }
    } else {
      this.controlSeeded = false;
      this.prevZoomY     = null;
    }

    // ── LEFT HAND → BUILD (pinch to place cubes) ─────────────────────────
    //
    // TAP  = rising-edge pinch → place one cube
    // HOLD = sustained pinch, hand moved > CELL → continuous draw
    //
    const build = this.buildHand;
    if (!build) {
      this.resetGestureState();
      this.renderer.render(this.scene, this.camera);
      return;
    }

    this.prevHandX = build.x;
    this.prevHandY = build.y;

    this.updateCursor(build);
    this.handleBuild(build);

    // Cursor mesh is parented to cubesGroup, so its position is already in
    // local space. Convert the world-space cursorPos using the full matrix
    // (handles both translation AND rotation), then snap to the grid.
    this.cubesGroup.updateWorldMatrix(true, false);
    const localCursor = this.cubesGroup.worldToLocal(this.cursorPos.clone());
    this.cursorMesh.position.set(
      Math.round(localCursor.x / CELL) * CELL,
      Math.round(localCursor.y / CELL) * CELL,
      Math.round(localCursor.z / CELL) * CELL,
    );

    this.renderer.render(this.scene, this.camera);
  }

  // ── Cursor: follows smooth position absolutely ────────────────────────────
  //
  // The ghost cube tracks the thumb-index midpoint directly.
  // cursorPos is the current smoothed world position — no delta accumulation.

  private updateCursor(hand: HandData) {
    const pos = this.getSmoothedWorldPos(hand);
    if (pos) this.cursorPos.copy(pos);
  }

  // ── Build: TAP + HOLD (mirrors reference implementation) ─────────────────
  //
  // TAP  — rising edge (lastPinch FALSE → TRUE): place one cube immediately.
  // HOLD — pinch held, hand moved more than CELL from last cube: place another.
  //
  // This matches the reference exactly:
  //   if(pinch && !lastPinch)  → createCube  (TAP)
  //   if(pinch && d > CUBE_SIZE) → createCube (HOLD continuous draw)

  private handleBuild(hand: HandData) {
    const pinching = hand.isPinching;
    const worldPos = this.getSmoothedWorldPos(hand);
    if (!worldPos) { this.wasPinching = pinching; return; }

    // Convert world finger position → cubesGroup local space for grid snapping.
    // Uses the full inverse transform (translation + rotation) so grid coords
    // stay correct regardless of how the group has been moved or rotated.
    this.cubesGroup.updateWorldMatrix(true, false);
    const local  = this.cubesGroup.worldToLocal(worldPos.clone());
    const localX = local.x;
    const localY = local.y;
    const localZ = local.z;

    // TAP — place one cube on the pinch leading edge
    if (pinching && !this.wasPinching) {
      const gx = Math.round(localX / CELL);
      const gy = Math.round(localY / CELL);
      const gz = Math.round(localZ / CELL);
      this.tryPlace(gx, gy, gz, worldPos);
      this.lastCubePos = worldPos.clone();
    }

    // HOLD — continuous draw: new cube whenever hand moves > CELL
    if (pinching && this.wasPinching && this.lastCubePos) {
      if (worldPos.distanceTo(this.lastCubePos) > CELL) {
        const gx = Math.round(localX / CELL);
        const gy = Math.round(localY / CELL);
        const gz = Math.round(localZ / CELL);
        this.tryPlace(gx, gy, gz, worldPos);
        this.lastCubePos = worldPos.clone();
      }
    }

    this.wasPinching = pinching; // store lastPinch state
  }

  /** Place a cube at integer grid coords if free and in bounds. Returns true if placed. */
  private tryPlace(gx: number, gy: number, gz: number, fingerPos: THREE.Vector3): boolean {
    if (Math.abs(gx) > BOUNDS || Math.abs(gy) > BOUNDS || Math.abs(gz) > BOUNDS) return false;
    const k = key3(gx, gy, gz);
    if (this.occupied.has(k)) return false;
    this.placeCube(gx, gy, gz, fingerPos);
    return true;
  }

  // ── Smoothing pipeline ────────────────────────────────────

  /**
   * Stage 1 — thumb-index midpoint world position.
   *
   * Mirrors the reference implementation: take the screen midpoint of
   * thumb tip (4) and index tip (8), apply screen-space smoothing (lerp 0.2),
   * then unproject via a raycaster at BUILD_DEPTH.  Simple and reliable.
   */
  private getRawWorldPos(hand: HandData): THREE.Vector3 | null {
    const lm = hand.landmarks;
    if (!lm || lm.length < 9) return null;

    const thumbTip = lm[4];
    const indexTip = lm[8];

    // Midpoint in MediaPipe normalised coords, X mirrored for flipped display
    const rawMx = 1 - (thumbTip.x + indexTip.x) / 2;
    const rawMy =     (thumbTip.y + indexTip.y) / 2;

    // Screen-space smoothing (lerp 0.2, same rate as reference)
    if (this.smoothMx < 0) { this.smoothMx = rawMx; this.smoothMy = rawMy; }
    else {
      this.smoothMx += (rawMx - this.smoothMx) * SCREEN_SMOOTH;
      this.smoothMy += (rawMy - this.smoothMy) * SCREEN_SMOOTH;
    }

    // Unproject to world space at fixed depth
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(
      new THREE.Vector2((this.smoothMx - 0.5) * 2, -(this.smoothMy - 0.5) * 2),
      this.camera,
    );
    return raycaster.ray.origin.clone()
      .addScaledVector(raycaster.ray.direction, BUILD_DEPTH);
  }

  /**
   * Stage 2: exponential smoothing with dead zone on the 3-D world position.
   * Speed-adaptive alpha: fast moves stay responsive, micro trembles ignored.
   */
  private getSmoothedWorldPos(hand: HandData): THREE.Vector3 | null {
    const raw = this.getRawWorldPos(hand);
    if (!raw) return null;

    if (!this.smoothWorldPos) {
      this.smoothWorldPos = raw.clone();
      return this.smoothWorldPos;
    }

    const dist = raw.distanceTo(this.smoothWorldPos);
    if (dist > DEAD_ZONE) {
      const alpha = Math.min(WORLD_SMOOTH * (dist / DEAD_ZONE), 0.35);
      this.smoothWorldPos.lerp(raw, alpha);
    }

    return this.smoothWorldPos;
  }

  // ── Cube creation ─────────────────────────────────────────

  private placeCube(gx: number, gy: number, gz: number, fingerPos: THREE.Vector3) {
    const k     = key3(gx, gy, gz);
    const group = new THREE.Group();

    const geo     = new THREE.BoxGeometry(CELL, CELL, CELL);
    const glowGeo = new THREE.BoxGeometry(CELL * 1.10, CELL * 1.10, CELL * 1.10);

    // Layer 1 — solid faces with Phong shading for depth
    // depthWrite: false lets cubes behind show through subtly
    group.add(new THREE.Mesh(
      geo,
      new THREE.MeshPhongMaterial({
        color:      0x003a55,   // deep blue base
        emissive:   0x001825,   // self-lit so faces are never fully dark
        specular:   WIRE_COLOR, // cyan specular highlight
        shininess:  90,
        transparent: true,
        opacity:    0.48,
        side:       THREE.DoubleSide,
        depthWrite: false,
      }),
    ));

    // Layer 2 — thin wireframe overlay so edges stay crisp and readable
    group.add(new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color:       WIRE_COLOR,
        wireframe:   true,
        transparent: true,
        opacity:     0.72,
      }),
    ));

    // Layer 3 — outer glow halo, additive so it blooms softly
    group.add(new THREE.Mesh(
      glowGeo,
      new THREE.MeshBasicMaterial({
        color:       WIRE_COLOR,
        wireframe:   true,
        transparent: true,
        opacity:     0.10,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
      }),
    ));

    // No rotation — all cubes axis-aligned
    group.rotation.set(0, 0, 0);

    // Convert finger world pos to cubesGroup local space for the spawn origin.
    // worldToLocal applies the full inverse transform (translation + rotation).
    this.cubesGroup.updateWorldMatrix(true, false);
    const localStart = this.cubesGroup.worldToLocal(fingerPos.clone());
    group.position.copy(localStart);
    group.scale.setScalar(0);
    this.cubesGroup.add(group); // parent to group, not scene

    this.occupied.add(k);
    this.cubesMap.set(k, { group });

    // Target is the world-space grid point (index × CELL on each axis)
    this.animateEmerge(group, new THREE.Vector3(gx * CELL, gy * CELL, gz * CELL));
  }

  private animateEmerge(group: THREE.Group, target: THREE.Vector3) {
    const start = group.position.clone();
    let elapsed = 0;
    const tick = () => {
      elapsed += 16;
      const t  = Math.min(elapsed / 160, 1);
      const et = 1 - Math.pow(1 - t, 2.5);  // ease-out cubic
      group.scale.setScalar(et);
      group.position.lerpVectors(start, target, et);
      if (t < 1) requestAnimationFrame(tick);
      else { group.position.copy(target); group.scale.setScalar(1); }
    };
    requestAnimationFrame(tick);
  }

  // ── Cube deletion ─────────────────────────────────────────

  private deleteNearest(worldPos: THREE.Vector3) {
    let bestKey  = "";
    let bestDist = Infinity;

    // Update once before the loop so localToWorld uses a fresh matrix.
    this.cubesGroup.updateWorldMatrix(true, false);

    this.cubesMap.forEach((_, k) => {
      const [x, y, z] = k.split(",").map(Number);
      // Grid indices are in local space; localToWorld applies translation + rotation.
      const cubeWorld = this.cubesGroup.localToWorld(
        new THREE.Vector3(x * CELL, y * CELL, z * CELL),
      );
      const d = worldPos.distanceTo(cubeWorld);
      if (d < bestDist) { bestDist = d; bestKey = k; }
    });

    if (!bestKey || bestDist >= 2.5 * CELL) return;

    const entry = this.cubesMap.get(bestKey)!;
    this.animateShrink(entry.group, () => {
      this.cubesGroup.remove(entry.group);
      entry.group.traverse(obj => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
    });

    this.occupied.delete(bestKey);
    this.cubesMap.delete(bestKey);

    // If deleted cube was the current build tip, clear it so next pinch starts fresh
    if (this.lastCubePos) {
      const [dx, dy, dz] = bestKey.split(",").map(Number);
      const deletedWorld = new THREE.Vector3(dx * CELL, dy * CELL, dz * CELL);
      if (this.lastCubePos.distanceTo(deletedWorld) < 0.001) {
        this.lastCubePos = null;
      }
    }
  }

  private animateShrink(group: THREE.Group, onDone: () => void) {
    const startY = group.position.y;
    let elapsed  = 0;
    const tick = () => {
      elapsed += 16;
      const t = Math.min(elapsed / 200, 1);
      group.scale.setScalar(1 - t);
      group.position.y = startY + t * 0.3;
      if (t < 1) requestAnimationFrame(tick);
      else onDone();
    };
    requestAnimationFrame(tick);
  }

  // ── Internal helpers ──────────────────────────────────────

  private cancelBuild() {
    this.pinchFrames = 0;
    this._deleteMode = false;
    this.holdMode    = false;
    this.wasPinching = false;
  }

  private resetGestureState() {
    this.wasPinching    = false;
    this.pinchFrames    = 0;
    this._deleteMode    = false;
    this.holdMode       = false;
    this.prevHandX      = -1;
    this.prevHandY      = -1;
    this.smoothMx       = -1;
    this.smoothMy       = -1;
    this.smoothWorldPos  = null;
    this.smoothFingerDir = null;
    this.prevWorldPos    = null;   // don't accumulate a jump-delta on re-entry
    // Keep lastCubePos and cursorPos — persistent across hand-off-screen moments
  }

  private applyVelocities() {
    if (Math.abs(this.velH) > 1e-6 || Math.abs(this.velV) > 1e-6) {
      // Yaw: rotate around world Y axis (horizontal hand movement)
      const qYaw = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 1, 0), -this.velH);

      // Pitch: rotate around camera's current local X axis (vertical hand movement)
      // Applying on the right side of camQuat = local-space rotation, so it
      // always tilts relative to the camera's own horizon — no gimbal lock.
      const qPitch = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -this.velV);

      // Compose: world yaw first, then local pitch
      this.camQuat.premultiply(qYaw).multiply(qPitch).normalize();
    }
    this.syncCamera();
  }

  // ── Resize / destroy ──────────────────────────────────────

  resize() {
    this.width  = window.innerWidth;
    this.height = window.innerHeight;
    this.renderer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  destroy() {
    this.scene.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    this.renderer.dispose();
  }
}
