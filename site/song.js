// The Kujira whale song: three long calls, slow glides between low tones with vibrato,
// rich in overtones, through a lowpass filter and a long synthetic reverb so it sounds distant and underwater.
// scripts/render-song.js renders it to audio/song.wav, which the page plays (an audio file
// plays even with an iPhone's ringer on silent, unlike live Web Audio). dive.js uses CALLS to
// draw the song on the sonar screen as it plays.
(() => {
  const CALLS = [
    { start: 0.05, path: [130, 310, 180], dur: 2.2 },
    { start: 2.65, path: [140, 105, 200], dur: 2.0 },
    { start: 5.05, path: [210, 420, 260, 150], dur: 2.8 },
  ];
  const LENGTH = 9.5; // seconds, including the reverb tail

  // Frequency of a call at `t` seconds into it (the glides are exponential ramps).
  function freqAt(call, t) {
    const segs = call.path.length - 1;
    const x = Math.min(Math.max(t / call.dur, 0), 1) * segs;
    const i = Math.min(Math.floor(x), segs - 1);
    const a = call.path[i], b = call.path[i + 1];
    return a * Math.pow(b / a, x - i);
  }

  function reverb(ac, seconds) {
    const len = Math.floor(ac.sampleRate * seconds);
    const buf = ac.createBuffer(2, len, ac.sampleRate);
    let seed = 52; // deterministic noise, so every render is identical
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = rand() * Math.pow(1 - i / len, 3);
    }
    const c = ac.createConvolver();
    c.buffer = buf;
    return c;
  }

  // Each call is a low moan with strong overtones. Phone speakers can't play much below
  // 300 Hz, so the overtones carry the call there and the ear fills in the low note; on
  // headphones the fundamental is heard as well.
  const HARMONICS = [0, 0.7, 0.8, 0.75, 0.68, 0.6, 0.5, 0.42, 0.34, 0.27, 0.2, 0.14];

  function voice(ac, out, { start, path, dur }) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const lfo = ac.createOscillator();
    const lfoGain = ac.createGain();
    osc.setPeriodicWave(ac.createPeriodicWave(new Float32Array(HARMONICS.length), new Float32Array(HARMONICS)));
    lfo.frequency.value = 4.5;
    lfoGain.gain.value = 5;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    osc.frequency.setValueAtTime(path[0], start);
    path.slice(1).forEach((f, i) => {
      osc.frequency.exponentialRampToValueAtTime(f, start + (dur * (i + 1)) / (path.length - 1));
    });
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.5, start + 0.35);
    gain.gain.setValueAtTime(0.5, start + dur - 0.5);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain);
    gain.connect(out);
    for (const o of [osc, lfo]) {
      o.start(start);
      o.stop(start + dur + 0.1);
    }
  }

  // Synthesize the whole song into `ac` (an AudioContext or OfflineAudioContext).
  function synth(ac) {
    const master = ac.createGain();
    master.gain.value = 0.32;
    const filter = ac.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2600;
    const wet = reverb(ac, 4);
    const wetGain = ac.createGain();
    wetGain.gain.value = 0.7;
    // A gentle compressor evens out the calls so the quiet parts still carry on a phone.
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.ratio.value = 4;
    filter.connect(master);
    filter.connect(wet);
    wet.connect(wetGain);
    wetGain.connect(master);
    // Soft saturation adds warmth and loudness without harsh clipping.
    const warm = ac.createWaveShaper();
    warm.curve = Float32Array.from({ length: 1025 }, (_, i) => Math.tanh(2.2 * (i / 512 - 1)) / Math.tanh(2.2));
    master.connect(comp);
    comp.connect(warm);
    warm.connect(ac.destination);
    for (const c of CALLS) voice(ac, filter, c);
  }

  window.KujiraSong = { CALLS, LENGTH, freqAt, synth };
})();
