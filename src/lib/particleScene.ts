import * as THREE from "three";
import { HandData } from "./handTracker";

const PARTICLE_COUNT = 1800;
const RIPPLE_COUNT = 12;

interface RippleData {
  x: number;
  y: number;
  age: number;
  maxAge: number;
  strength: number;
  mesh: THREE.Mesh;
}

export class ParticleScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private particles!: THREE.Points;
  private positions!: Float32Array;
  private colors!: Float32Array;
  private sizes!: Float32Array;
  private velocities: { vx: number; vy: number }[] = [];
  private basePositions: { x: number; y: number }[] = [];
  private canvas: HTMLCanvasElement;
  private width: number;
  private height: number;
  private hand: HandData | null = null;
  private ripples: RippleData[] = [];
  private time = 0;
  private attractMesh!: THREE.Mesh;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.width = window.innerWidth;
    this.height = window.innerHeight;

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true,
        premultipliedAlpha: false,
        powerPreference: "high-performance",
      });
    } catch {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false,
        alpha: true,
        premultipliedAlpha: false,
      });
    }
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Transparent background — video shows through
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(
      -this.width / 2, this.width / 2,
      this.height / 2, -this.height / 2,
      -1000, 1000
    );
    this.camera.position.z = 100;

    this.initParticles();
    this.initAttractorGlow();
  }

  private initParticles() {
    const geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(PARTICLE_COUNT * 3);
    this.colors = new Float32Array(PARTICLE_COUNT * 3);
    this.sizes = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const x = (Math.random() - 0.5) * this.width;
      const y = (Math.random() - 0.5) * this.height;
      this.positions[i * 3] = x;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = 0;

      // Vivid teal-cyan-white palette — stands out over real video
      const t = Math.random();
      this.colors[i * 3] = 0.05 + t * 0.15;   // subtle red
      this.colors[i * 3 + 1] = 0.85 + t * 0.15; // strong green
      this.colors[i * 3 + 2] = 0.85 + t * 0.15; // strong blue

      this.sizes[i] = 2.5 + Math.random() * 4;

      this.basePositions.push({ x, y });
      this.velocities.push({
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
      });
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(this.sizes, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        pixelRatio: { value: this.renderer.getPixelRatio() },
      },
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float time;
        uniform float pixelRatio;

        void main() {
          vColor = color;
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * pixelRatio * (400.0 / -mvPos.z);
          gl_Position = projectionMatrix * mvPos;
          // Twinkle: 0.65..1.0 range so particles are always quite visible
          vAlpha = 0.65 + 0.35 * sin(time * 1.4 + position.x * 0.01 + position.y * 0.009);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;

          // Soft glow falloff
          float glow = smoothstep(0.5, 0.05, d);
          // Bright hard core for AR visibility
          float core = smoothstep(0.12, 0.0, d);
          float alpha = glow * vAlpha;

          // Blow out the center to white-teal for punch
          vec3 col = mix(vColor, vec3(0.8, 1.0, 1.0), core * 0.7);
          // Extra halo ring brightness
          col += vColor * 0.4 * smoothstep(0.5, 0.3, d);

          gl_FragColor = vec4(col, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);
  }

  private initAttractorGlow() {
    // A soft glow disk that follows the hand
    const geo = new THREE.CircleGeometry(120, 64);
    const mat = new THREE.ShaderMaterial({
      uniforms: { opacity: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform float opacity;
        void main() {
          vec2 c = vUv - 0.5;
          float d = length(c);
          float a = smoothstep(0.5, 0.0, d) * opacity;
          gl_FragColor = vec4(0.04, 0.85, 0.78, a * 0.22);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.attractMesh = new THREE.Mesh(geo, mat);
    this.attractMesh.position.z = -1;
    this.scene.add(this.attractMesh);
  }

  updateHand(hand: HandData | null) {
    this.hand = hand;

    if (!hand) return;

    // Spawn ripple on fast move or palm open
    if (hand.speed > 0.25 || hand.isOpen) {
      const hx = (hand.x - 0.5) * this.width;
      const hy = -(hand.y - 0.5) * this.height;

      if (this.ripples.length < RIPPLE_COUNT) {
        this.addRipple(hx, hy, hand.speed + (hand.isOpen ? 0.4 : 0));
      }
    }
  }

  private addRipple(x: number, y: number, strength: number) {
    const geo = new THREE.RingGeometry(0, 2, 64);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        radius: { value: 0 },
        opacity: { value: 1 },
        color: { value: new THREE.Color(0.05, 0.85, 0.76) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform float opacity;
        uniform vec3 color;
        void main() {
          gl_FragColor = vec4(color, opacity * 0.6);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, 0);
    this.scene.add(mesh);

    this.ripples.push({
      x, y,
      age: 0,
      maxAge: 60 + strength * 30,
      strength: Math.min(strength + 0.3, 1.2),
      mesh,
    });
  }

  render() {
    this.time += 0.016;
    const mat = this.particles.material as THREE.ShaderMaterial;
    mat.uniforms.time.value = this.time;

    const handX = this.hand ? (this.hand.x - 0.5) * this.width : 9999;
    const handY = this.hand ? -(this.hand.y - 0.5) * this.height : 9999;
    const handDepth = this.hand?.depth ?? 0;
    const openness = this.hand?.openness ?? 0;

    const attractRadius = 180 + handDepth * 200 + openness * 120;
    const repelRadius = openness > 0.55 ? attractRadius * 0.7 : 0;

    // Update attractor glow — brighter so it's visible over video
    if (this.hand) {
      this.attractMesh.position.set(handX, handY, -1);
      const glowScale = (1 + handDepth * 1.5 + openness * 0.8) * 1.4;
      this.attractMesh.scale.setScalar(glowScale);
      (this.attractMesh.material as THREE.ShaderMaterial).uniforms.opacity.value =
        0.7 + openness * 0.3;
    } else {
      (this.attractMesh.material as THREE.ShaderMaterial).uniforms.opacity.value = 0;
    }

    // Update particles
    const posAttr = this.particles.geometry.getAttribute("position") as THREE.BufferAttribute;
    const colAttr = this.particles.geometry.getAttribute("color") as THREE.BufferAttribute;
    const sizeAttr = this.particles.geometry.getAttribute("size") as THREE.BufferAttribute;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      let px = this.positions[i * 3];
      let py = this.positions[i * 3 + 1];

      // Gentle float drift
      const baseX = this.basePositions[i].x;
      const baseY = this.basePositions[i].y;
      const driftX = Math.sin(this.time * 0.3 + i * 0.07) * 0.4;
      const driftY = Math.cos(this.time * 0.25 + i * 0.05) * 0.4;

      let vx = this.velocities[i].vx;
      let vy = this.velocities[i].vy;

      if (this.hand) {
        const dx = handX - px;
        const dy = handY - py;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;

        if (dist < attractRadius) {
          const norm = dist / attractRadius;
          const forceMag = (1 - norm) * 0.06 * (1 + handDepth);

          if (repelRadius > 0 && dist < repelRadius) {
            // Repel on open palm
            const repelMag = (1 - dist / repelRadius) * 0.3;
            vx -= (dx / dist) * repelMag;
            vy -= (dy / dist) * repelMag;
          } else {
            // Attract
            vx += (dx / dist) * forceMag;
            vy += (dy / dist) * forceMag;
          }
        }

        // Ripple displacement
        for (const r of this.ripples) {
          const rdx = r.x - px;
          const rdy = r.y - py;
          const rdist = Math.sqrt(rdx * rdx + rdy * rdy) + 0.01;
          const rProgress = r.age / r.maxAge;
          const rRadius = rProgress * 350 * r.strength;
          const ringWidth = 60;
          const distFromRing = Math.abs(rdist - rRadius);
          if (distFromRing < ringWidth) {
            const ripplePush = (1 - distFromRing / ringWidth) * 2.5 * r.strength * (1 - rProgress);
            vx += (rdx / rdist) * ripplePush * -1;
            vy += (rdy / rdist) * ripplePush * -1;
          }
        }

        // Color shift near hand — white-hot core, vivid teal halo
        const colorInfluence = Math.max(0, 1 - dist / (attractRadius * 1.5));
        this.colors[i * 3] = 0.05 + colorInfluence * 0.7;   // more red near hand = white
        this.colors[i * 3 + 1] = 0.85 + colorInfluence * 0.15;
        this.colors[i * 3 + 2] = 0.85 + colorInfluence * 0.15;
        this.sizes[i] = (2.5 + Math.random() * 3) * (1 + colorInfluence * 2.5);
      } else {
        // No hand: float back to base
        const toBaseX = baseX - px;
        const toBaseY = baseY - py;
        vx += toBaseX * 0.004;
        vy += toBaseY * 0.004;

        // Keep vivid teal even without hand
        const ct = Math.sin(i * 0.37) * 0.5 + 0.5;
        this.colors[i * 3] = 0.05 + ct * 0.1;
        this.colors[i * 3 + 1] = 0.80 + ct * 0.15;
        this.colors[i * 3 + 2] = 0.85 + ct * 0.1;
        this.sizes[i] = 2.5 + Math.random() * 3;
      }

      // Dampen & update
      vx *= 0.88;
      vy *= 0.88;
      vx += driftX * 0.04;
      vy += driftY * 0.04;

      px += vx;
      py += vy;

      // Wrap around edges
      const hw = this.width / 2;
      const hh = this.height / 2;
      if (px < -hw) px = hw;
      if (px > hw) px = -hw;
      if (py < -hh) py = hh;
      if (py > hh) py = -hh;

      this.positions[i * 3] = px;
      this.positions[i * 3 + 1] = py;
      this.velocities[i].vx = vx;
      this.velocities[i].vy = vy;
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;

    // Update ripples
    for (let r = this.ripples.length - 1; r >= 0; r--) {
      const rip = this.ripples[r];
      rip.age++;

      const progress = rip.age / rip.maxAge;
      const rRadius = progress * 350 * rip.strength;
      rip.mesh.scale.setScalar(rRadius);
      const mat2 = rip.mesh.material as THREE.ShaderMaterial;
      mat2.uniforms.opacity.value = (1 - progress) * 0.8;

      if (rip.age >= rip.maxAge) {
        this.scene.remove(rip.mesh);
        rip.mesh.geometry.dispose();
        (rip.mesh.material as THREE.Material).dispose();
        this.ripples.splice(r, 1);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.renderer.setSize(this.width, this.height);
    this.camera.left = -this.width / 2;
    this.camera.right = this.width / 2;
    this.camera.top = this.height / 2;
    this.camera.bottom = -this.height / 2;
    this.camera.updateProjectionMatrix();
  }

  destroy() {
    this.renderer.dispose();
    this.particles.geometry.dispose();
    (this.particles.material as THREE.Material).dispose();
    for (const r of this.ripples) {
      r.mesh.geometry.dispose();
      (r.mesh.material as THREE.Material).dispose();
    }
  }
}
