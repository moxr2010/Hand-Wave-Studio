import * as THREE from "three";
import { HandData } from "./handTracker";

const CELL = 0.25;

export class BuildingScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;

  private cubes: THREE.Group;
  private cursor: THREE.Mesh;

  private hand: HandData | null = null;
  private occupied = new Set<string>();

  constructor(canvas: HTMLCanvasElement) {
    // ── Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });

    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);

    // ── Scene
    this.scene = new THREE.Scene();

    // ── Camera (IMPORTANT: ثابتة وواضحة)
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );

    this.camera.position.set(0, 0, 8);
    this.camera.lookAt(0, 0, 0);

    // ── Light
    this.scene.add(new THREE.AmbientLight(0xffffff, 1));

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(3, 3, 3);
    this.scene.add(light);

    // ── Groups
    this.cubes = new THREE.Group();
    this.scene.add(this.cubes);

    // ── Cursor
    const geo = new THREE.BoxGeometry(CELL, CELL, CELL);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00c8ff,
      wireframe: true,
    });

    this.cursor = new THREE.Mesh(geo, mat);
    this.scene.add(this.cursor);

    // resize fix
    window.addEventListener("resize", () => this.resize());
  }

  updateHands(hands: HandData[]) {
    this.hand = hands.find(h => h.label === "Left") ?? null;
  }

  render() {
    if (!this.hand) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const h = this.hand;

    // ── IMPORTANT: تحويل نظيف للإحداثيات
    const targetX = (h.x - 0.5) * 6;
    const targetY = -(h.y - 0.5) * 6;
    const targetZ = -h.depth * 3;

    // smooth cursor
    this.cursor.position.x += (targetX - this.cursor.position.x) * 0.3;
    this.cursor.position.y += (targetY - this.cursor.position.y) * 0.3;
    this.cursor.position.z += (targetZ - this.cursor.position.z) * 0.3;

    // ── PINCH = place cube
    if (h.isPinching) {
      const gx = Math.round(this.cursor.position.x / CELL);
      const gy = Math.round(this.cursor.position.y / CELL);
      const gz = Math.round(this.cursor.position.z / CELL);

      const key = `${gx},${gy},${gz}`;

      if (!this.occupied.has(key)) {
        this.occupied.add(key);

        const cube = new THREE.Mesh(
          new THREE.BoxGeometry(CELL, CELL, CELL),
          new THREE.MeshStandardMaterial({
            color: 0x003a55,
            emissive: 0x001820,
          })
        );

        cube.position.set(gx * CELL, gy * CELL, gz * CELL);
        this.cubes.add(cube);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  destroy() {
    this.renderer.dispose();
  }
}
