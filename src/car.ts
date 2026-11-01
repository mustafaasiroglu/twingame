import * as THREE from 'three';

export interface Wheel { pivot: THREE.Group; spin: THREE.Group; front: boolean }
interface Section { z: number; width: number; bottom: number; top: number; roofWidth?: number }
function loft(sections: Section[]): THREE.BufferGeometry {
  const vertices: number[] = [], indices: number[] = [];
  for (const s of sections) {
    const roof = s.roofWidth ?? s.width - 0.08;
    const shoulder = s.roofWidth === undefined ? s.width : s.roofWidth + 0.03;
    const bevel = Math.min(0.08, (s.top - s.bottom) / 4);
    for (const [x, y] of [[-s.width + 0.08, s.bottom], [s.width - 0.08, s.bottom], [s.width, s.bottom + bevel], [shoulder, s.top - bevel], [roof, s.top], [-roof, s.top], [-shoulder, s.top - bevel], [-s.width, s.bottom + bevel]]) {
      vertices.push(x, y, s.z);
    }
  }
  for (let s = 0; s < sections.length - 1; s++) for (let i = 0; i < 8; i++) {
    const a = s * 8 + i, b = s * 8 + (i + 1) % 8, c = b + 8, d = a + 8;
    indices.push(a, b, c, a, c, d);
  }
  for (let i = 1; i < 7; i++) {
    indices.push(0, i + 1, i);
    const base = (sections.length - 1) * 8;
    indices.push(base, base + i, base + i + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  g.setIndex(indices); g.computeVertexNormals();
  return g;
}

export function addCar(body: THREE.Group, p: Record<string, THREE.Color>): Wheel[] {
  const dark = document.documentElement.dataset.theme === 'dark';
  const neutral = dark ? p['bg-elevated'] : p.text;
  const white = dark ? p.text : p.surface;
  const paint = new THREE.MeshPhysicalMaterial({ color: p.accent, roughness: 0.28, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.18 });
  const trim = new THREE.MeshStandardMaterial({ color: neutral, roughness: 0.8 });
  const alloy = new THREE.MeshStandardMaterial({ color: p['border-strong'], roughness: 0.24, metalness: 0.8 });
  const glass = new THREE.MeshPhysicalMaterial({ color: neutral, roughness: 0.08, metalness: 0.25, clearcoat: 1, side: THREE.DoubleSide });
  const box = (w: number, h: number, l: number, x: number, y: number, z: number, material: THREE.Material, parent = body) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), material);
    mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  };
  box(1.3, 0.15, 2.6, 0, 0.265, 0, trim);
  body.add(new THREE.Mesh(loft([
    { z: -1.9, width: 0.79, bottom: 0.43, top: 0.84 },
    { z: -1.55, width: 0.86, bottom: 0.42, top: 0.95 },
    { z: -0.7, width: 0.88, bottom: 0.42, top: 0.96 },
    { z: 0.55, width: 0.88, bottom: 0.42, top: 0.96 },
    { z: 1.35, width: 0.85, bottom: 0.43, top: 0.9 },
    { z: 1.9, width: 0.77, bottom: 0.46, top: 0.79 },
  ]), paint));
  body.add(new THREE.Mesh(loft([
    { z: -1.14, width: 0.73, bottom: 0.9, top: 1.02 },
    { z: -0.78, width: 0.74, roofWidth: 0.64, bottom: 0.92, top: 1.43 },
    { z: 0.28, width: 0.74, roofWidth: 0.64, bottom: 0.92, top: 1.45 },
    { z: 0.72, width: 0.73, bottom: 0.9, top: 1.01 },
  ]), paint));
  const pane = (points: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    g.setIndex([0, 1, 2, 0, 2, 3]); g.computeVertexNormals();
    body.add(new THREE.Mesh(g, glass));
  };
  pane([-0.66, 1.015, 0.725, 0.66, 1.015, 0.725, 0.61, 1.435, 0.3, -0.61, 1.435, 0.3]);
  pane([-0.65, 1.025, -1.145, -0.61, 1.41, -0.8, 0.61, 1.41, -0.8, 0.65, 1.025, -1.145]);
  for (const sign of [-1, 1]) {
    pane([sign * 0.749, 0.99, 0.6, sign * 0.679, 1.36, 0.24, sign * 0.679, 1.36, -0.12, sign * 0.749, 0.99, -0.12]);
    pane([sign * 0.749, 0.99, -0.19, sign * 0.679, 1.36, -0.19, sign * 0.679, 1.34, -0.72, sign * 0.749, 0.99, -1.0]);
    box(0.08, 0.12, 0.2, sign * 0.95, 1.01, 0.55, paint);
    box(0.035, 0.035, 0.14, sign * 0.884, 0.86, -0.26, trim);
    box(0.035, 0.08, 1.45, sign * 0.88, 0.43, 0, trim);
    const arch = new THREE.Mesh(new THREE.TorusGeometry(0.375, 0.028, 8, 24, Math.PI), trim);
    arch.rotation.y = Math.PI / 2;
    for (const z of [-1.18, 1.18]) {
      const copy = arch.clone(); copy.position.set(sign * 0.89, 0.34, z); body.add(copy);
    }
  }
  box(1.58, 0.12, 0.08, 0, 0.48, -1.91, trim);
  box(1.58, 0.12, 0.08, 0, 0.48, 1.91, trim);
  box(1.08, 0.18, 0.035, 0, 0.6, 1.923, trim);
  const light = new THREE.MeshBasicMaterial({ color: white, toneMapped: false });
  const rearLight = new THREE.MeshStandardMaterial({ color: p.accent, emissive: p.accent, emissiveIntensity: 0.75 });
  for (const x of [-0.55, 0.55]) {
    box(0.42, 0.07, 0.025, x, 0.755, 1.91, light);
    box(0.54, 0.085, 0.025, x, 0.81, -1.913, rearLight);
  }
  const plateCanvas = document.createElement('canvas');
  plateCanvas.width = 256; plateCanvas.height = 64;
  const ctx = plateCanvas.getContext('2d');
  if (!ctx) throw new Error('Vehicle plate canvas is unavailable');
  ctx.fillStyle = white.getStyle(); ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = neutral.getStyle(); ctx.font = 'bold 36px Consolas, monospace'; ctx.textAlign = 'center'; ctx.fillText('TWIN 01', 128, 46);
  const plateTexture = new THREE.CanvasTexture(plateCanvas); plateTexture.colorSpace = THREE.SRGBColorSpace;
  const plate = new THREE.MeshBasicMaterial({ map: plateTexture, toneMapped: false });
  box(0.45, 0.12, 0.015, 0, 0.66, -1.954, plate);
  box(0.45, 0.12, 0.015, 0, 0.6, 1.949, plate);
  const wheels: Wheel[] = [];
  for (const x of [-0.86, 0.86]) for (const z of [-1.18, 1.18]) {
    const pivot = new THREE.Group(), spin = new THREE.Group();
    pivot.position.set(x, 0.34, z); pivot.add(spin); body.add(pivot);
    const tire = new THREE.Mesh(new THREE.TorusGeometry(0.255, 0.085, 12, 32), trim);
    tire.rotation.y = Math.PI / 2; spin.add(tire);
    const disk = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.13, 24), alloy);
    disk.rotation.z = Math.PI / 2; spin.add(disk);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.16, 12), trim);
    hub.rotation.z = Math.PI / 2; spin.add(hub);
    for (let i = 0; i < 5; i++) {
      const angle = i * Math.PI * 2 / 5;
      const spoke = box(0.025, 0.035, 0.16, Math.sign(x) * 0.085, Math.sin(angle) * 0.105, Math.cos(angle) * 0.105, light, spin);
      spoke.rotation.x = -angle;
    }
    wheels.push({ pivot, spin, front: z > 0 });
  }
  const alpha = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const d = Math.hypot((x - 31.5) / 32, (y - 31.5) / 32);
    alpha.set([255, 255, 255, Math.round(Math.max(0, 1 - d) ** 1.5 * 110)], (y * 64 + x) * 4);
  }
  const shadowTexture = new THREE.DataTexture(alpha, 64, 64); shadowTexture.needsUpdate = true;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 4.4), new THREE.MeshBasicMaterial({
    color: neutral, map: shadowTexture, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.025; body.add(shadow);
  return wheels;
}
