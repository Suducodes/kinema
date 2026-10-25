import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Stage } from './stage';

/**
 * The gait lab: a graphite floor running to a fogged horizon under a faint technical grid,
 * lit by softboxes that live in the reflection environment (no three.js lights: every light
 * would cost every material per pixel). The floor shader lights its own pools from the same
 * softboxes and draws soft, moving contact shadows under each foot. Two treadmills.
 */
const KEYS = [
  { color: 0xfff1e4, intensity: 60, pos: [-3.8, 6.0, 5.4], angle: 0.7 },    // key, front left, high
  { color: 0xcfe2ff, intensity: 90, pos: [4.6, 3.6, -4.4], angle: 0.6 },    // cool rim, back right
  { color: 0xffe4c8, intensity: 60, pos: [-5.2, 2.8, -4.0], angle: 0.6 },   // warm rim, back left
] as const;
const HEMI = { color: 0xa9bcc8, intensity: 0.30 };
export const TREADMILL = { length: 1.7, width: 0.62, deck: 0.11 };
const MAX_FEET = 8;

function softboxEnvironment(renderer: THREE.WebGLRenderer) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(30, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: /* glsl */ `
      varying vec3 vP;
      void main() {
        float h = normalize(vP).y;
        vec3 c = h < 0.0 ? mix(vec3(0.15,0.16,0.17), vec3(0.02,0.022,0.025), smoothstep(0.0,-0.35,h))
                         : mix(vec3(0.15,0.16,0.17), vec3(0.04,0.045,0.05), smoothstep(0.0,0.7,h));
        gl_FragColor = vec4(c, 1.0);
      }`,
  })));
  const box = (w: number, h: number, pos: THREE.Vector3Tuple, k: number, tint = 0xffffff) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(0, 1, 0); scene.add(m);
  };
  box(10, 2.2, [0, 8, 0.5], 3.2, 0xfff6ec);       // long overhead strip
  box(2.6, 7, [9, 4, 2], 0.9, 0xd8e8ff);          // cool side strip (kept low: it greyed the bone)
  box(6, 5, [-4, 4.5, 9], 2.6, 0xfff0e2);         // big warm key softbox, camera side, high left
  box(14, 1.2, [0, 0.6, 12], 0.5, 0xfff4ea);      // low front bounce
  for (const k of KEYS) {
    const at = new THREE.Vector3(...k.pos).multiplyScalar(1.2);
    const d = at.distanceTo(new THREE.Vector3(0, 1, 0));
    box(3.2, 3.2, at.toArray() as THREE.Vector3Tuple, (k.intensity / d ** 1.6) / (10.24 / (d * d)) * 0.8, k.color);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0.02).texture;
  pmrem.dispose();
  return tex;
}

function sky() {
  return new THREE.Mesh(new THREE.SphereGeometry(90, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: /* glsl */ `
      varying vec3 vP;
      void main() {
        float h = normalize(vP).y;
        // one continuous cyclorama tone: the horizon matches the floor's fog colour, so no seam
        vec3 horizon = vec3(0.030, 0.035, 0.039), top = vec3(0.010, 0.012, 0.014);
        vec3 c = h < 0.0 ? horizon : mix(horizon, top, smoothstep(0.0, 0.5, h));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
}

/** Satin graphite floor: softbox pools, foot contact shadows, fog and grid in one pass. */
function floorMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAlbedo: { value: new THREE.Color(0x262b2e) },
      uSpotPos: { value: KEYS.map(() => new THREE.Vector3()) },
      uSpotDir: { value: KEYS.map(() => new THREE.Vector3()) },
      uSpotCol: { value: KEYS.map(() => new THREE.Color()) },
      uSpotCone: { value: KEYS.map(() => new THREE.Vector2()) },
      uHemi: { value: new THREE.Color() },
      uFogColor: { value: new THREE.Color(0.030, 0.035, 0.039) },   // = sky horizon (linear)
      uFogDensity: { value: 0.085 },
      uFeet: { value: Array.from({ length: MAX_FEET }, () => new THREE.Vector4()) },  // x, z, height, size
      uDecks: { value: [new THREE.Vector4(), new THREE.Vector4()] },                  // x, z, half length, half width
    },
    vertexShader: /* glsl */ `
      varying vec3 vW; varying float vDepth;
      void main() { vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vec4 mv = viewMatrix * w; vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uAlbedo, uHemi, uFogColor;
      uniform vec3 uSpotPos[3], uSpotDir[3], uSpotCol[3];
      uniform vec2 uSpotCone[3];
      uniform float uFogDensity;
      uniform vec4 uFeet[${MAX_FEET}];
      uniform vec4 uDecks[2];
      varying vec3 vW; varying float vDepth;
      float line(vec2 p, float s) { vec2 g = abs(fract(p / s - 0.5) - 0.5) * s / fwidth(p); return 1.0 - min(min(g.x, g.y), 1.0); }
      float box(vec2 p, vec2 b, float r) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r; }
      void main() {
        vec3 V = normalize(cameraPosition - vW);
        vec3 diffuse = uHemi, sheen = vec3(0.0);
        for (int i = 0; i < 3; i++) {
          vec3 L = uSpotPos[i] - vW; float d = length(L); L /= d;
          float spot = smoothstep(uSpotCone[i].x, uSpotCone[i].y, dot(L, uSpotDir[i]));
          float fall = 1.0 / max(pow(d, 1.6), 0.01) * pow(clamp(1.0 - pow(d / 30.0, 4.0), 0.0, 1.0), 2.0);
          vec3 E = uSpotCol[i] * spot * fall * L.y;
          diffuse += E;
          sheen += E * pow(max(normalize(L + V).y, 0.0), 24.0) * 0.05;
        }
        vec3 c = uAlbedo * diffuse * 0.31831 + sheen;
        // the overhead key's pool on the floor around the treadmills, falling off into the dark
        float pool = exp(-dot(vW.xz * vec2(0.42, 0.7), vW.xz * vec2(0.42, 0.7)));
        c += uAlbedo * vec3(1.0, 0.95, 0.9) * pool * 1.4;
        // treadmill decks: broad soft occlusion around each footprint
        float occ = 0.0;
        for (int i = 0; i < 2; i++) {
          float dd = box(vW.xz - uDecks[i].xy, uDecks[i].zw, 0.02);
          occ = max(occ, (1.0 - smoothstep(-0.02, 0.35, dd)) * 0.7);
        }
        c *= 1.0 - occ;
        float r = length(vW.xz);
        float grid = (line(vW.xz, 0.5) * 0.035 + line(vW.xz, 5.0) * 0.09) * (1.0 - smoothstep(3.0, 22.0, r));
        c = mix(c, vec3(0.55, 0.68, 0.74), grid);
        float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
        gl_FragColor = vec4(mix(c, uFogColor, fog), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/** Rubber belt: fine transverse ribs that scroll at belt speed, plus foot contact shadows. */
function beltMaterial() {
  const m = new THREE.MeshPhysicalMaterial({ color: 0x0b0c0d, roughness: 0.82, metalness: 0, sheen: 0.4, sheenColor: new THREE.Color(0x2a2e31) });
  const uniforms = {
    uScroll: { value: 0 },
    uFeet: { value: Array.from({ length: MAX_FEET }, () => new THREE.Vector4()) },
  };
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorldK;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldK = (modelMatrix * vec4(transformed,1.0)).xyz;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vWorldK; uniform float uScroll; uniform vec4 uFeet[${MAX_FEET}];`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      { float x = (vWorldK.x + uScroll) / 0.008;                     // 8 mm rib pitch
        float rib = sin(x * 6.2831853);
        normal = normalize(normal + vec3(0.0, 0.0, 0.0) + (viewMatrix * vec4(rib * 0.18, 0.0, 0.0, 0.0)).xyz); }`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
      { float sh = 0.0;
        for (int i = 0; i < ${MAX_FEET}; i++) {
          vec2 d = (vWorldK.xz - uFeet[i].xy) / vec2(uFeet[i].w, uFeet[i].w * 0.42);
          float lift = clamp(uFeet[i].z / 0.12, 0.0, 1.0);
          sh = max(sh, exp(-dot(d, d) * (2.2 - 1.4 * lift)) * (0.85 - 0.75 * lift));
        }
        reflectedLight.indirectDiffuse *= 1.0 - sh; reflectedLight.indirectSpecular *= 1.0 - sh; }`);
  };
  return { material: m, uniforms };
}

export class Studio {
  readonly group = new THREE.Group();
  readonly belts: ReturnType<typeof beltMaterial>[] = [];
  private readonly decks: THREE.Group[] = [];
  private readonly floor: THREE.ShaderMaterial;

  constructor(stage: Stage, deckXs: number[]) {
    stage.scene.environment = softboxEnvironment(stage.renderer);
    stage.scene.fog = new THREE.FogExp2(new THREE.Color(0.030, 0.035, 0.039).getHex(), 0.085);
    stage.scene.background = new THREE.Color(0.030, 0.035, 0.039);
    this.floor = floorMaterial();
    const floor = new THREE.Mesh(new THREE.CircleGeometry(80, 128), this.floor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -TREADMILL.deck;
    floor.renderOrder = 20;
    const dome = sky(); dome.renderOrder = 21;
    this.group.add(dome, floor);
    deckXs.forEach((x, i) => { const d = this.treadmill(x, i); this.decks.push(d); this.group.add(d); });
    stage.scene.add(this.group);
    this.syncFloor(deckXs);
  }

  /** Move / show the treadmills (overlay mode stacks both walkers on one). */
  layout(xs: number[], visible: boolean[]) {
    this.decks.forEach((d, i) => { d.position.x = xs[i]; d.visible = visible[i]; });
    const u = this.floor.uniforms;
    xs.forEach((x, i) => u.uDecks.value[i].set(visible[i] ? x : 999, 0, (TREADMILL.length + 0.24) / 2, (TREADMILL.width + 0.26) / 2));
  }

  private treadmill(x: number, i: number) {
    const g = new THREE.Group();
    g.position.x = x;
    const { length: L, width: W, deck: D } = TREADMILL;
    const paint = new THREE.MeshPhysicalMaterial({ color: 0x1c1f22, roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.25 });
    const alu = new THREE.MeshPhysicalMaterial({ color: 0xc9ccd0, roughness: 0.3, metalness: 1 });
    const deck = new THREE.Mesh(new RoundedBoxGeometry(L + 0.24, D, W + 0.26, 4, 0.018), paint);
    deck.position.y = -D / 2 - 0.004;
    const belt = beltMaterial();
    this.belts[i] = belt;
    const beltMesh = new THREE.Mesh(new THREE.PlaneGeometry(L, W, 1, 1), belt.material);
    beltMesh.rotation.x = -Math.PI / 2;
    beltMesh.position.y = -0.0015;
    g.add(deck, beltMesh);
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new RoundedBoxGeometry(L + 0.2, 0.022, 0.09, 3, 0.006), alu);
      rail.position.set(0, 0.006, side * (W / 2 + 0.06));
      g.add(rail);
    }
    return g;
  }

  private syncFloor(deckXs: number[]) {
    const u = this.floor.uniforms, aim = new THREE.Vector3(0, 1, 0);
    KEYS.forEach((k, i) => {
      u.uSpotPos.value[i].set(...k.pos);
      u.uSpotDir.value[i].set(...k.pos).sub(aim).normalize();
      u.uSpotCol.value[i].set(k.color).multiplyScalar(k.intensity);
      u.uSpotCone.value[i].set(Math.cos(k.angle), Math.cos(k.angle * 0.25));
    });
    u.uHemi.value.set(HEMI.color).multiplyScalar(HEMI.intensity);
    deckXs.forEach((x, i) => u.uDecks.value[i].set(x, 0, (TREADMILL.length + 0.24) / 2, (TREADMILL.width + 0.26) / 2));
  }

  /** Belt scroll (m) and foot positions [x, z, height, size] for contact shadows, per treadmill. */
  update(i: number, scroll: number, feet: THREE.Vector4[]) {
    const b = this.belts[i];
    if (!b) return;
    b.uniforms.uScroll.value = scroll;
    for (let k = 0; k < MAX_FEET; k++) b.uniforms.uFeet.value[k].copy(feet[k] ?? new THREE.Vector4(0, 0, 9, 0.001));
  }
}
