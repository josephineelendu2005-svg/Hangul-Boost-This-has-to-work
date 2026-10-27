// Vercel serverless function: POST /api/transcribe?ext=mp4
// Receives raw audio, forwards it to Groq's hosted Whisper, returns Korean text.
// The secret key lives ONLY in the GROQ_API_KEY environment variable on Vercel.

const MAX_BYTES = 4 * 1024 * 1024; // Vercel request-body limit is ~4.5 MB
const EXTS = ['mp4', 'm4a', 'webm', 'ogg', 'wav', 'mp3'];

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.GROQ_API_KEY;

  // Health check used by the diagnostic page. Never reveals the key.
  if (req.method === 'GET') return res.status(200).json({ ok: true, configured: !!key });
  if (req.method !== 'POST') return res.status(405).json({ code: 'method', message: 'Use POST.' });
  if (!key) {
    return res.status(500).json({
      code: 'no_key',
      message: 'The server has no GROQ_API_KEY. Add it in Vercel → Settings → Environment Variables, then redeploy.',
    });
  }

  let buf;
  try { buf = await readBody(req); } catch (e) {
    return res.status(400).json({ code: 'bad_body', message: 'Could not read the audio upload.' });
  }
  if (!buf || buf.length < 1000) return res.status(400).json({ code: 'empty', message: 'The recording was empty.' });
  if (buf.length > MAX_BYTES) return res.status(413).json({ code: 'too_big', message: 'The recording was too long.' });

  const ext = EXTS.includes(req.query && req.query.ext) ? req.query.ext : 'mp4';
  const form = new FormData();
  form.append('file', new Blob([buf]), 'audio.' + ext);
  form.append('model', process.env.STT_MODEL || 'whisper-large-v3-turbo');
  form.append('language', 'ko');
  form.append('prompt', '한국어 단어입니다.');
  form.append('temperature', '0');
  form.append('response_format', 'verbose_json');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let r;
  try {
    r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key },
      body: form,
      signal: ctl.signal,
    });
  } catch (e) {
    return res.status(504).json({ code: 'upstream_unreachable', message: 'The speech service did not answer in time.' });
  } finally {
    clearTimeout(timer);
  }

  if (r.status === 401) return res.status(502).json({ code: 'bad_key', message: 'The speech service rejected the API key.' });
  if (r.status === 429) return res.status(429).json({ code: 'rate_limit', message: 'Free speech limit reached for now. Wait a minute and try again.' });
  if (!r.ok) return res.status(502).json({ code: 'upstream', message: 'The speech service returned an error (' + r.status + ').' });

  let j;
  try { j = await r.json(); } catch (e) {
    return res.status(502).json({ code: 'upstream', message: 'Unreadable response from the speech service.' });
  }

  // Whisper sometimes invents text for silence/noise. Drop segments it itself flags as non-speech.
  const segs = Array.isArray(j.segments) ? j.segments : [];
  const isNoise = (s) => (s.no_speech_prob || 0) > 0.6 && (s.avg_logprob || 0) < -1;
  const noSpeech = segs.length > 0 && segs.every(isNoise);
  const text = noSpeech ? '' : String(j.text || '').trim();
  return res.status(200).json({ text, noSpeech, language: j.language || 'ko' });
};
