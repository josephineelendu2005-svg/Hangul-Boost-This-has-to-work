/* Hangul Boost recorder: getUserMedia + MediaRecorder, then upload to /api/transcribe.
   Used by both diagnostic.html and index.html. */
window.HBRec = (function () {
  const MAX_MS = 20000;      // hard safety cap so recording can never run forever
  const SPEECH_RMS = 0.025;  // level that counts as "speaking"
  const SILENT_PEAK = 0.012; // whole recording quieter than this = nothing was said
  const END_SILENCE_MS = 1500; // auto-finish after you speak and then go quiet

  const err = (code, detail) => Object.assign(new Error(code), { code, detail });

  function support() {
    const gum = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const mr = typeof MediaRecorder !== 'undefined';
    const secure = window.isSecureContext;
    return { gum, mr, secure, ok: gum && mr && secure, type: mr ? pickType() : '' };
  }

  function pickType() {
    const list = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (const t of list) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) {} }
    return '';
  }
  const extFor = (t) => (/mp4|aac/.test(t) ? 'mp4' : /ogg/.test(t) ? 'ogg' : 'webm');

  // Call this directly from a tap handler. Resolves to a controller { stop(), done }.
  async function begin(onLevel) {
    const sup = support();
    if (!sup.secure) throw err('insecure');
    if (!sup.gum || !sup.mr) throw err('unsupported');

    // Create the AudioContext first, still inside the tap, so iOS lets it run.
    let ac = null;
    try { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ac = new AC(); } catch (e) {}

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      if (ac) try { ac.close(); } catch (x) {}
      const n = e && e.name;
      if (n === 'NotAllowedError' || n === 'PermissionDeniedError') throw err('denied');
      if (n === 'NotFoundError' || n === 'OverconstrainedError') throw err('nomic');
      if (n === 'NotReadableError' || n === 'AbortError') throw err('busy');
      if (n === 'SecurityError') throw err('insecure');
      throw err('micfail', n);
    }

    let an = null;
    try {
      if (ac) {
        if (ac.state === 'suspended') await ac.resume();
        if (ac.state === 'running') {
          const src = ac.createMediaStreamSource(stream);
          an = ac.createAnalyser(); an.fftSize = 1024; src.connect(an);
        }
      }
    } catch (e) { an = null; }

    const type = sup.type;
    let rec;
    try { rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined); }
    catch (e) { stream.getTracks().forEach((t) => t.stop()); throw err('unsupported', e && e.message); }

    const chunks = [];
    const t0 = Date.now();
    let peak = 0, spoke = false, lastLoud = 0, timer = null, cap = null, finished = false;
    const buf = an ? new Uint8Array(an.fftSize) : null;

    const done = new Promise((resolve, reject) => {
      const release = () => {
        clearInterval(timer); clearTimeout(cap);
        stream.getTracks().forEach((t) => t.stop());          // turns the mic indicator off
        if (ac) try { ac.close(); } catch (e) {}
      };
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onerror = (e) => { release(); reject(err('recfail', e && e.error && e.error.name)); };
      rec.onstop = () => {
        if (finished) return; finished = true; release();
        const mime = rec.mimeType || type || 'audio/mp4';
        const blob = new Blob(chunks, { type: mime });
        if (blob.size < 1000) return reject(err('empty'));
        resolve({
          blob, type: mime, ext: extFor(mime), bytes: blob.size, ms: Date.now() - t0,
          peak: an ? peak : null,
          silent: !!an && peak > 0 && peak < SILENT_PEAK, // peak===0 means the meter itself is dead: don't trust it
        });
      };
    });

    const stop = () => { try { if (rec.state !== 'inactive') rec.stop(); } catch (e) {} };

    if (an) {
      timer = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        if (rms > peak) peak = rms;
        if (onLevel) onLevel(Math.min(1, rms * 6));
        const now = Date.now();
        if (rms > SPEECH_RMS) { spoke = true; lastLoud = now; }
        else if (spoke && now - lastLoud > END_SILENCE_MS) stop();
      }, 80);
    }
    cap = setTimeout(stop, MAX_MS);
    rec.start();
    return { stop, done };
  }

  // Upload the recording and get Korean text back.
  async function transcribe(r, opts) {
    const endpoint = (opts && opts.endpoint) || '/api/transcribe';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const resp = await fetch(endpoint + '?ext=' + encodeURIComponent(r.ext), {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: r.blob, signal: ctl.signal,
      });
      let j = null; try { j = await resp.json(); } catch (e) {}
      if (!resp.ok) throw err((j && j.code) || 'http' + resp.status, j && j.message);
      return j || { text: '' };
    } catch (e) {
      if (e && e.name === 'AbortError') throw err('timeout');
      if (e && e.code) throw e;
      throw err('network');
    } finally { clearTimeout(timer); }
  }

  const MSG = {
    insecure: 'This page is not on a secure (https) address, so Safari blocks the microphone.',
    unsupported: 'This browser can’t record audio. Update iOS, then use Safari. You can still type answers.',
    denied: 'Microphone permission was denied. In Safari tap the aA icon → Website Settings → Microphone → Allow, then reload. (Also check Settings → Privacy & Security → Microphone.)',
    nomic: 'No microphone was found. Check that nothing is covering it and no headset is half-plugged in.',
    busy: 'The microphone is being used by another app or call. Close it and try again.',
    micfail: 'The microphone could not start.',
    recfail: 'Recording failed part-way. Please try again.',
    empty: 'Nothing was recorded. Tap the mic, wait for the green bar to move, then speak.',
    silent: 'I couldn’t hear any sound. Hold the phone closer and speak a little louder.',
    timeout: 'The speech service took too long. Check your connection and try again.',
    network: 'Couldn’t reach the server. Check your internet connection.',
    no_key: 'The server has no speech key set up yet (see README, step 4).',
    bad_key: 'The speech key on the server was rejected. Check GROQ_API_KEY in Vercel.',
    rate_limit: 'The free speech limit was reached for now. Wait a minute and try again, or type your answer.',
    upstream_unreachable: 'The speech service didn’t answer. Try again in a moment.',
    upstream: 'The speech service had a problem. Try again in a moment.',
    too_big: 'That recording was too long. Try a single word.',
    http404: 'The /api/transcribe function was not found. Deploy the whole project folder to Vercel (see README).',
  };
  const explain = (e) => (e && MSG[e.code]) || (e && e.detail) || 'Something went wrong' + (e && e.code ? ' (' + e.code + ')' : '') + '.';

  return { support, begin, transcribe, explain };
})();
