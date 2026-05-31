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

  private lastPinch = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });

    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );

    this.camera.position.set(0, 0, 6);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1));

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(2, 3, 2);
    this.scene.add(light);

    this.cubes = new THREE.Group();
    this.scene.add(this.cubes);

    const geo = new THREE.BoxGeometry(CELL, CELL, CELL);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00c8ff,
      wireframe: true,
    });

    this.cursor = new THREE.Mesh(geo, mat);
    this.scene.add(this.cursor);
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

    // 🎯 حركة ناعمة
    this.cursor.position.lerp(
      new THREE.Vector3(h.x, h.y, -h.depth * 2),
      0.35
    );

    // 🤏 pinch edge detection
    const pinchStart = h.isPinching && !this.lastPinch;

    if (pinchStart) {
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

    this.lastPinch = h.isPinching;

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
