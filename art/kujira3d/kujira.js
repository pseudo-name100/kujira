// The Kujira, modelled in code with three.js. createKujira(THREE) returns { group, update }:
// add `group` to a scene and call update(t) each frame to swim (t in seconds).
// The body is a tube of rings along a spine that waves up and down (whales swim with
// vertical strokes); flukes, fins and face ride on the spine.

export function createKujira(THREE, { swim = 1 } = {}) {
  const L = 4; // nose to tail root
  const RINGS = 80, SEG = 96;
  const group = new THREE.Group();

  // radius along the body: a blunt, friendly head, a full chest, a long taper to the tail
  const radius = (u) => {
    if (u < 0.24) return 0.86 * Math.sqrt(Math.sin((u / 0.24) * Math.PI / 2));
    return 0.86 * (1 - 0.9 * ((u - 0.24) / 0.76) ** 1.15);
  };
  // spine at time t: x along the body, y waving with the stroke (more toward the tail)
  const spine = (u, t) => {
    const x = L / 2 - u * L;
    // the tail curls up at the end, like the logo
    const y = Math.sin(t * 2.4 * swim - u * 3.0) * u * u * 0.32 * swim - 0.06 * Math.sin(Math.PI * u) + 0.55 * Math.max(0, u - 0.6) ** 2 * 4;
    return [x, y];
  };

  // ---- body geometry
  const pos = new Float32Array(RINGS * SEG * 3);
  const col = new Float32Array(RINGS * SEG * 3);
  const idx = [];
  const back = new THREE.Color("#3ea9dc"), side = new THREE.Color("#cfeaf7"), belly = new THREE.Color("#ffffff"), groove = new THREE.Color("#3fc6ea");
  const c = new THREE.Color();
  for (let i = 0; i < RINGS; i++) {
    const u = i / (RINGS - 1);
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2; // 0 = top
      const up = Math.cos(a); // 1 top, -1 belly
      if (up > 0.15) c.copy(side).lerp(back, Math.min(1, (up - 0.15) / 0.6));
      else c.copy(belly).lerp(side, Math.max(0, (up + 0.25) / 0.4));
      // cyan grooves along the throat and belly, like the logo's swirl
      if (up < -0.35 && u > 0.08 && u < 0.55) {
        const stripe = Math.sin(a * 22);
        if (stripe > 0.72) c.copy(groove);
      }
      // a smile, painted on both sides of the head, turning up at the corner
      const am = 1.98 - 9 * (u - 0.13) ** 2 * (u > 0.13 ? 3 : 0.4);
      const aa = a > Math.PI ? Math.PI * 2 - a : a;
      if (u > 0.035 && u < 0.2 && Math.abs(aa - am) < 0.045) c.set("#0b2236");
      col.set([c.r, c.g, c.b], (i * SEG + j) * 3);
      if (i < RINGS - 1) {
        const n = (j + 1) % SEG;
        const p0 = i * SEG + j, p1 = i * SEG + n, p2 = (i + 1) * SEG + j, p3 = (i + 1) * SEG + n;
        idx.push(p0, p2, p1, p1, p2, p3);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);

  const toonRamp = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]), 3, 1);
  toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter;
  toonRamp.needsUpdate = true;
  const skin = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonRamp });
  const body = new THREE.Mesh(geo, skin);
  group.add(body);

  // cartoon outline: the same body drawn slightly fattened, back faces only, dark blue
  const outlineMat = new THREE.MeshBasicMaterial({ color: "#0d3150", side: THREE.BackSide });
  outlineMat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace("#include <begin_vertex>", "vec3 transformed = position + normal * 0.035;");
  };
  group.add(new THREE.Mesh(geo, outlineMat));

  // ---- flukes: two curved lobes, flat like a real whale's, riding the tail
  const fluke = new THREE.Shape();
  fluke.moveTo(0, 0);
  fluke.bezierCurveTo(-0.15, 0.25, -0.55, 0.85, -1.05, 0.95);
  fluke.bezierCurveTo(-0.85, 0.55, -0.75, 0.25, -0.62, 0.0);
  fluke.bezierCurveTo(-0.75, -0.25, -0.85, -0.55, -1.05, -0.95);
  fluke.bezierCurveTo(-0.55, -0.85, -0.15, -0.25, 0, 0);
  const flukeGeo = new THREE.ExtrudeGeometry(fluke, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 4, curveSegments: 24 });
  flukeGeo.translate(0, 0, -0.025);
  const flukeMat = new THREE.MeshToonMaterial({ color: "#7cc6ea", gradientMap: toonRamp });
  const tail = new THREE.Group();
  const flukes = new THREE.Mesh(flukeGeo, flukeMat);
  flukes.scale.setScalar(0.9);
  tail.add(flukes);
  const flukeLine = new THREE.Mesh(flukeGeo, outlineMat);
  flukeLine.scale.setScalar(0.9);
  tail.add(flukeLine);
  group.add(tail);

  // ---- pectoral fins
  const finGeo = new THREE.SphereGeometry(1, 24, 16);
  finGeo.scale(0.55, 0.06, 0.2);
  finGeo.translate(-0.45, 0, 0);
  const fins = [1, -1].map((s) => {
    const f = new THREE.Group();
    const m = new THREE.Mesh(finGeo, new THREE.MeshToonMaterial({ color: "#9fd6f0", gradientMap: toonRamp }));
    const o = new THREE.Mesh(finGeo, outlineMat);
    f.add(m, o);
    f.userData.side = s;
    group.add(f);
    return f;
  });

  // ---- face: big eyes with a highlight, a smile, a blowhole
  const eyeMat = new THREE.MeshBasicMaterial({ color: "#0b2236" });
  const shineMat = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  const eyes = [1, -1].map((s) => {
    const e = new THREE.Group();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.115, 24, 16), eyeMat);
    ball.scale.set(0.8, 1.05, 0.55);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.032, 12, 8), shineMat);
    shine.position.set(0.03, 0.045, 0.05 * s);
    e.add(ball, shine);
    e.userData.side = s;
    group.add(e);
    return e;
  });
  const smiles = [];
  const blowhole = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 8), new THREE.MeshBasicMaterial({ color: "#2b8fb6" }));
  blowhole.scale.set(1.4, 0.25, 0.7);
  group.add(blowhole);

  // a point on the body surface at (u, angle a from the top, around the spine)
  const surface = (u, a, t, out = 1) => {
    const [x, y] = spine(u, t);
    const r = radius(u) * out;
    return new THREE.Vector3(x, y + Math.cos(a) * r, Math.sin(a) * r * 0.86);
  };

  function update(t) {
    for (let i = 0; i < RINGS; i++) {
      const u = i / (RINGS - 1);
      const [x, y] = spine(u, t);
      const [x2, y2] = spine(Math.min(1, u + 0.01), t);
      const pitch = Math.atan2(y2 - y, x - x2); // rings tilt with the spine
      const r = radius(u);
      for (let j = 0; j < SEG; j++) {
        const a = (j / SEG) * Math.PI * 2;
        const ry = Math.cos(a) * r * (Math.cos(a) > 0 ? 1.0 : 0.94), rz = Math.sin(a) * r * 0.86;
        const k = (i * SEG + j) * 3;
        pos[k] = x + Math.sin(pitch) * ry;
        pos[k + 1] = y + Math.cos(pitch) * ry;
        pos[k + 2] = rz;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    // tail: at the end of the spine, pitched with it, flukes beating a little behind
    const [tx, ty] = spine(1, t), [px, py] = spine(0.96, t);
    tail.position.set(tx, ty, 0);
    // the fluke shape points along -x; turn it to follow the tail's direction
    tail.rotation.z = Math.atan2(py - ty, px - tx) + Math.sin(t * 2.4 * swim - 3.4) * 0.22 * swim;

    for (const f of fins) {
      const s = f.userData.side;
      const p = surface(0.3, s * 1.95, t);
      f.position.copy(p);
      f.rotation.set(s * (0.45 + Math.sin(t * 2.4 * swim + 1.2) * 0.25), s * 0.55, -0.55);
    }
    for (const e of eyes) {
      const s = e.userData.side;
      const p = surface(0.12, s * 1.3, t, 0.98);
      e.position.copy(p);
      e.rotation.set(0, s * 0.5, 0);
    }
    for (const m of smiles) {
      const s = m.userData.side;
      const p = surface(0.08, s * 1.75, t, 1.0);
      m.position.copy(p).add(new THREE.Vector3(-0.17, 0.12, 0));
      m.rotation.set(0, s * 0.55, Math.PI * 1.15);
    }
    blowhole.position.copy(surface(0.24, 0, t, 0.99));
  }

  update(0);
  return { group, update, length: L };
}
