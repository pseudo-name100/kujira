// The Kujira whale song: three long calls, slow glides between low tones with vibrato,
// through a lowpass filter and a long synthetic reverb so it sounds distant and underwater.
// scripts/render-song.js renders it to audio/song.wav, which the page plays (an audio file
// plays even with an iPhone's ringer on silent, unlike live Web Audio). dive.js uses CALLS to
// draw the song on the sonar screen as it plays.
(() => {
  const CALLS = [
    { start: 0.05, path: [130, 310, 180], dur: 2.2 },
    { start: 2.65, path: [95, 70, 140], dur: 2.0 },
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

  function voice(ac, out, { start, path, dur }) {
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

  // Synthesize the whole song into `ac` (an AudioContext or OfflineAudioContext).
  function synth(ac) {
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
    for (const c of CALLS) voice(ac, filter, c);
  }

  window.KujiraSong = { CALLS, LENGTH, freqAt, synth };
})();
