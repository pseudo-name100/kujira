// The Dive: the page is a descent from the surface to the deep. As you scroll, the water
// darkens, sunlight fades, marine snow and then bioluminescence appear, and the gauge reads
// the depth of the section you're looking at. The hero's sonar screen is a live spectrogram
// with the 52 Hz whale on it; "Hear the song" plays the recorded call (song.js) and draws it.
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
  // A pre-rendered file (song.js + scripts/render-song.js): an <audio> element plays with an
  // iPhone's ringer on silent, which live Web Audio doesn't.
  let player = null;
  let playing = false;
  // Any [data-sing] element starts the song; [data-sing-label] ones also show its state.
  const singers = () => document.querySelectorAll("[data-sing]");
  function setSinging(on, label) {
    for (const el of singers()) el.classList.toggle("singing", on);
    for (const el of document.querySelectorAll("[data-sing-label]")) el.textContent = label;
  }
  function sing() {
    // Ask iOS to treat this as media playback, not an ambient sound.
    try {
      if (navigator.audioSession) navigator.audioSession.type = "playback";
    } catch {}
    player ||= new Audio("audio/song.wav");
    player.currentTime = 0;
    player.onended = () => {
      playing = false;
      setSinging(false, "Hear the song");
    };
    player.play().then(
      () => {
        playing = true;
        setSinging(true, "Listening…");
      },
      () => setSinging(false, "Tap again to listen")
    );
  }
  for (const el of singers()) {
    el.addEventListener("click", sing); // home page only
    el.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), sing()));
  }

  // ------------------------------------------------------------------ the sonar screen
  // A scrolling spectrogram, 0-400 Hz: faint ocean noise, and the 52 Hz whale's pulsed call.
  // While the song plays, its real frequencies are drawn from the audio itself.
  const spectro = $("spectro");
  if (spectro) {
    const sc = spectro.getContext("2d");
    const MAX_HZ = 400;
    let sw = 0, sh = 0, sdpr = 1, freq = null;
    const size = () => {
      sdpr = Math.min(devicePixelRatio || 1, 2);
      sw = spectro.clientWidth;
      sh = spectro.clientHeight;
      spectro.width = sw * sdpr;
      spectro.height = sh * sdpr;
      sc.setTransform(sdpr, 0, 0, sdpr, 0, 0);
      sc.fillStyle = "#000a0f";
      sc.fillRect(0, 0, sw, sh);
    };
    size();
    addEventListener("resize", size);
    const yOf = (hz) => sh - (hz / MAX_HZ) * sh;
    let t0 = performance.now();
    const step = (now) => {
      const t = (now - t0) / 1000;
      const dx = 2;
      // scroll left
      sc.drawImage(spectro, dx * sdpr, 0, (sw - dx) * sdpr, sh * sdpr, 0, 0, sw - dx, sh);
      const x = sw - dx;
      sc.fillStyle = "rgba(0, 10, 15, 0.92)";
      sc.fillRect(x, 0, dx, sh);
      // ocean noise
      for (let i = 0; i < 26; i++) {
        const y = Math.random() * sh;
        sc.fillStyle = `rgba(63, 198, 234, ${Math.random() * 0.09})`;
        sc.fillRect(x, y, dx, 1 + Math.random() * 2);
      }
      // the 52 Hz whale: long tonal pulses, a few seconds on, a few off
      const on = (t % 6) < 3.4;
      if (on) {
        const wobble = Math.sin(t * 1.7) * 1.5;
        const y = yOf(52 + wobble);
        const g = sc.createLinearGradient(0, y - 6, 0, y + 6);
        g.addColorStop(0, "rgba(143, 230, 255, 0)");
        g.addColorStop(0.5, "rgba(170, 240, 255, 0.95)");
        g.addColorStop(1, "rgba(143, 230, 255, 0)");
        sc.fillStyle = g;
        sc.fillRect(x, y - 6, dx, 12);
      }
      // the song, drawn from its notes in time with playback
      if (playing && window.KujiraSong) {
        const now = player.currentTime;
        for (const c of window.KujiraSong.CALLS) {
          const into = now - c.start;
          if (into < 0 || into > c.dur) continue;
          const env = Math.min(1, into / 0.35, (c.dur - into) / 0.5);
          const f = window.KujiraSong.freqAt(c, into) + Math.sin(now * 2 * Math.PI * 4.5) * 5;
          for (const [mult, alpha, thick] of [[1, 1, 7], [2, 0.35, 4]]) {
            const y = yOf(f * mult);
            if (y < 0) continue;
            const g = sc.createLinearGradient(0, y - thick, 0, y + thick);
            g.addColorStop(0, "rgba(170, 240, 255, 0)");
            g.addColorStop(0.5, `rgba(225, 250, 255, ${alpha * env})`);
            g.addColorStop(1, "rgba(170, 240, 255, 0)");
            sc.fillStyle = g;
            sc.fillRect(x, y - thick, dx, thick * 2);
          }
        }
      }
      if (!reduceMotion && !document.hidden) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    document.addEventListener("visibilitychange", () => !document.hidden && !reduceMotion && requestAnimationFrame(step));
  }

  measure();
  update();
  requestAnimationFrame(frame);
  addEventListener("load", () => {
    measure();
    update();
  });
})();
