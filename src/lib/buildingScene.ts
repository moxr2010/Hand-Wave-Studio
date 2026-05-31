import * as THREE from "three";
import { HandData } from "./handTracker";

const CELL = 0.2;
const WIRE_COLOR = 0x00c8ff;

export class BuildingScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;

  private cubesGroup: THREE.Group;
  private cursor: THREE.Mesh;

  private occupied = new Set<string>();

  private buildHand: HandData | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });

    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );

    this.camera.position.set(0, 0, 6);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(2, 2, 2);
    this.scene.add(light);

    this.cubesGroup = new THREE.Group();
    this.scene.add(this.cubesGroup);

    const geo = new THREE.BoxGeometry(CELL, CELL, CELL);
    const mat = new THREE.MeshBasicMaterial({
      color: WIRE_COLOR,
      wireframe: true,
    });

    this.cursor = new THREE.Mesh(geo, mat);
    this.scene.add(this.cursor);
  }

  updateHands(hands: HandData[]) {
    this.buildHand = hands.find(h => h.label === "Left") ?? null;
  }

  render() {
    if (!this.buildHand) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const hand = this.buildHand;

    // ✨ تحسين مهم: smoothing بسيط بدل قفزات
    const x = THREE.MathUtils.lerp(
      this.cursor.position.x,
      (hand.x - 0.5) * 4,
      0.35
    );

    const y = THREE.MathUtils.lerp(
      this.cursor.position.y,
      -(hand.y - 0.5) * 4,
      0.35
    );

    const z = THREE.MathUtils.lerp(
      this.cursor.position.z,
      hand.depth * 3,
      0.25
    );

    this.cursor.position.set(x, y, z);

    // 🤏 BUILD
    if (hand.isPinching) {
      const gx = Math.round(x / CELL);
      const gy = Math.round(y / CELL);
      const gz = Math.round(z / CELL);

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
        this.cubesGroup.add(cube);
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
