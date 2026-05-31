import * as THREE from "three";
import { HandData } from "./handTracker";

const CELL = 0.2;
const WIRE_COLOR = 0x00c8ff;

export class BuildingScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;

  private cubesGroup: THREE.Group;
  private cursor: THREE.Mesh;

  private occupied = new Set<string>();
  private buildHand: HandData | null = null;

  constructor(canvas: HTMLCanvasElement) {
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
      55,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );

    // 🔥 هذا أهم تعديل (كان يسبب اختفاء المكعب)
    this.camera.position.set(0, 0, 8);
    this.camera.lookAt(0, 0, 0);

    // lights (خفيفة لكن واضحة)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));

    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(3, 3, 3);
    this.scene.add(light);

    this.cubesGroup = new THREE.Group();
    this.scene.add(this.cubesGroup);

    // cursor
    const geo = new THREE.BoxGeometry(CELL, CELL, CELL);
    const mat = new THREE.MeshBasicMaterial({
      color: WIRE_COLOR,
      wireframe: true,
    });

    this.cursor = new THREE.Mesh(geo, mat);
    this.scene.add(this.cursor);

    // 🔥 مهم: resize fix
    window.addEventListener("resize", () => this.resize());
  }

  updateHands(hands: HandData[]) {
    this.buildHand = hands.find((h) => h.label === "Left") ?? null;
  }

  render() {
    if (!this.buildHand) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const hand = this.buildHand;

    // 🔥 إصلاح الإحداثيات (كان سبب "اختفاء الحركة")
    const targetX = (0.5 - hand.x) * 6;
    const targetY = -(hand.y - 0.5) * 6;
    const targetZ = -hand.depth * 3;

    // smoothing
    this.cursor.position.x = THREE.MathUtils.lerp(this.cursor.position.x, targetX, 0.35);
    this.cursor.position.y = THREE.MathUtils.lerp(this.cursor.position.y, targetY, 0.35);
    this.cursor.position.z = THREE.MathUtils.lerp(this.cursor.position.z, targetZ, 0.35);

    // 🤏 بناء مكعب
    if (hand.isPinching) {
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
