// The Dive: the page is a descent from the surface to the deep. As you scroll, the water
// darkens, sunlight fades, marine snow and then bioluminescence appear, and the gauge reads
// the depth of the section you're looking at. Tapping the whale plays a synthesized song.
(() => {
  const $ = (id) => document.getElementById(id);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Water colour by depth (metres)
  const WATER = [
    [0, [14, 96, 128]],
    [200, [8, 58, 82]],
    [1000, [3, 22, 32]],
    [4000, [1, 7, 11]],
    [11000, [0, 0, 0]],
  ];

  const lerp = (a, b, t) => a + (b - a) * t;
  function waterAt(depth) {
    for (let i = 1; i < WATER.length; i++) {
      const [d1, c1] = WATER[i];
      const [d0, c0] = WATER[i - 1];
      if (depth <= d1) {
        const t = (depth - d0) / (d1 - d0);
        return c0.map((v, k) => Math.round(lerp(v, c1[k], t)));
      }
    }
    return WATER.at(-1)[1];
  }

  // Depth = interpolated between the data-depth of the sections above and below the
  // middle of the screen, so the gauge always matches the zone labels.
  let anchors = [];
  function measure() {
    anchors = [...document.querySelectorAll("[data-depth]")]
      .map((el) => ({
        top: el.getBoundingClientRect().top + scrollY,
        depth: Number(el.dataset.depth),
        zone: el.dataset.zone,
      }))
      .sort((a, b) => a.top - b.top);
  }

  function depthNow() {
    // Reads at the middle of the screen, easing in from the very top so the page starts at 0 m.
    const y = scrollY + innerHeight * 0.5 * Math.min(1, scrollY / (innerHeight * 0.6));
    if (!anchors.length || y <= anchors[0].top) return { depth: 0, zone: anchors[0]?.zone || "" };
    for (let i = 1; i < anchors.length; i++) {
      const a = anchors[i - 1];
      const b = anchors[i];
      if (y < b.top) return { depth: lerp(a.depth, b.depth, (y - a.top) / (b.top - a.top)), zone: a.zone };
    }
    return { depth: anchors.at(-1).depth, zone: anchors.at(-1).zone };
  }

  let depth = 0;
  function update() {
    const now = depthNow();
    depth = now.depth;
    const [r, g, b] = waterAt(depth);
    $("ocean").style.background = `radial-gradient(120% 80% at 50% 0%, rgb(${r + 10},${g + 14},${b + 16}), rgb(${r},${g},${b}) 60%, rgb(${Math.round(r * 0.6)},${Math.round(g * 0.6)},${Math.round(b * 0.6)}))`;
    $("rays").style.opacity = Math.max(0, 1 - depth / 450).toFixed(3);
    $("depth").textContent = Math.round(depth).toLocaleString("en-US");
    $("zone").textContent = now.zone;
    document.querySelector('meta[name="theme-color"]').content = `rgb(${r},${g},${b})`;
  }

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      update();
      ticking = false;
    });
  };
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", () => {
    measure();
    sizeCanvas();
    update();
  });
  // Content above (fonts, the token split, panels) can change height after load.
  new ResizeObserver(() => {
    measure();
    update();
  }).observe(document.body);

  // ------------------------------------------------------------------ marine snow
  const canvas = $("snow");
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1;
  function sizeCanvas() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth;
    H = innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizeCanvas();

  const N = innerWidth < 600 ? 45 : 80;
  const flecks = Array.from({ length: N }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: 0.6 + Math.random() * 1.6,
    v: 0.00004 + Math.random() * 0.00012, // fraction of the screen per ms
    sway: Math.random() * Math.PI * 2,
    glow: Math.random() < 0.18, // some become bioluminescent in the abyss
  }));

  let last = performance.now();
  function frame(t) {
    const dt = Math.min(64, t - last);
    last = t;
    ctx.clearRect(0, 0, W, H);
    const snow = Math.min(1, Math.max(0, (depth - 150) / 900)); // fades in below 150 m
    const bio = Math.min(1, Math.max(0, (depth - 2500) / 2000)); // glow below 2,500 m
    for (const f of flecks) {
      if (!reduceMotion) {
        f.y += f.v * dt * (f.glow ? 0.5 : 1); // drifts down, like marine snow
        f.sway += dt * 0.0006;
        if (f.y > 1.02) {
          f.y = -0.02;
          f.x = Math.random();
        }
      }
      const x = (f.x + Math.sin(f.sway) * 0.006) * W;
      const y = f.y * H;
      if (f.glow && bio > 0) {
        const pulse = 0.55 + 0.45 * Math.sin(t * 0.002 + f.sway * 3);
        ctx.shadowBlur = 12;
        ctx.shadowColor = `rgba(90, 220, 255, ${bio})`;
        ctx.fillStyle = `rgba(140, 235, 255, ${(0.35 + 0.6 * pulse) * bio})`;
        ctx.beginPath();
        ctx.arc(x, y, f.r + 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      } else if (snow > 0) {
        ctx.fillStyle = `rgba(220, 235, 240, ${0.35 * snow})`;
        ctx.beginPath();
        ctx.arc(x, y, f.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (!document.hidden) requestAnimationFrame(frame);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      last = performance.now();
      requestAnimationFrame(frame);
    }
  });

  // ------------------------------------------------------------------ whale song
  // Three long calls: slow glides between low tones with vibrato, through a lowpass
  // filter and a long synthetic reverb, so it sounds distant and underwater.
  let audio;
  function reverb(ac, seconds) {
    const len = ac.sampleRate * seconds;
    const buf = ac.createBuffer(2, len, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    const c = ac.createConvolver();
    c.buffer = buf;
    return c;
  }

  function call(ac, out, start, path, dur) {
    const osc = ac.createOscillator();
    const over = ac.createOscillator(); // a quiet harmonic for body
    const gain = ac.createGain();
    const overGain = ac.createGain();
    const lfo = ac.createOscillator();
    const lfoGain = ac.createGain();
    osc.type = "sine";
    over.type = "triangle";
    lfo.frequency.value = 4.5;
    lfoGain.gain.value = 5;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfoGain.connect(over.frequency);

    osc.frequency.setValueAtTime(path[0], start);
    over.frequency.setValueAtTime(path[0] * 2, start);
    path.slice(1).forEach((f, i) => {
      const at = start + (dur * (i + 1)) / (path.length - 1);
      osc.frequency.exponentialRampToValueAtTime(f, at);
      over.frequency.exponentialRampToValueAtTime(f * 2, at);
    });

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.5, start + 0.35);
    gain.gain.setValueAtTime(0.5, start + dur - 0.5);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    overGain.gain.value = 0.12;

    osc.connect(gain);
    over.connect(overGain);
    overGain.connect(gain);
    gain.connect(out);
    for (const o of [osc, over, lfo]) {
      o.start(start);
      o.stop(start + dur + 0.1);
    }
  }

  function sing() {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const ac = audio;
    ac.resume();
    const t = ac.currentTime + 0.05;
    const master = ac.createGain();
    master.gain.value = 0.32;
    const filter = ac.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1100;
    const wet = reverb(ac, 4);
    const wetGain = ac.createGain();
    wetGain.gain.value = 0.7;
    filter.connect(master);
    filter.connect(wet);
    wet.connect(wetGain);
    wetGain.connect(master);
    master.connect(ac.destination);

    call(ac, filter, t, [130, 310, 180], 2.2);
    call(ac, filter, t + 2.6, [95, 70, 140], 2.0);
    call(ac, filter, t + 5.0, [210, 420, 260, 150], 2.8);

    const coin = $("sing");
    coin.classList.add("singing");
    clearTimeout(sing.timer);
    sing.timer = setTimeout(() => coin.classList.remove("singing"), 8500);
  }
  $("sing").addEventListener("click", sing);

  measure();
  update();
  requestAnimationFrame(frame);
  addEventListener("load", () => {
    measure();
    update();
  });
})();
