import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HUNYUAN = 'https://tokenhub.tencentmaas.com/v1/wand/asrproxy/sync_transcribe';
const WAV_HEADER_BYTES = 44;
const WAV_BYTES_PER_SECOND = 16000 * 2;
const MAX_WAV_BYTES = WAV_HEADER_BYTES + 60 * WAV_BYTES_PER_SECOND;
const MAX_BASE64_BYTES = Math.ceil(MAX_WAV_BYTES / 3) * 4;
export const VOICE_REQUEST_LIMIT = MAX_BASE64_BYTES + 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });

// Match the canonical mono PCM files produced by composer-pcm.js. The physical
// sample count, not a client-supplied duration or a compressed size, bounds cost.
function isPcmWav(bytes) {
  const samplesSize = bytes.length - WAV_HEADER_BYTES;
  return samplesSize > 0 && samplesSize % 2 === 0
    && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === bytes.length - 8
    && bytes.toString('latin1', 8, 16) === 'WAVEfmt ' && bytes.readUInt32LE(16) === 16
    && bytes.readUInt16LE(20) === 1 && bytes.readUInt16LE(22) === 1
    && bytes.readUInt32LE(24) === 16000 && bytes.readUInt32LE(28) === WAV_BYTES_PER_SECOND
    && bytes.readUInt16LE(32) === 2 && bytes.readUInt16LE(34) === 16
    && bytes.toString('latin1', 36, 40) === 'data' && bytes.readUInt32LE(40) === samplesSize;
}

export function loadManagedVoice(credentialDirectory) {
  if (!credentialDirectory) return undefined;
  const file = path.join(credentialDirectory, 'ashub-voice');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    console.error('Unable to read the asHub voice credential');
    return undefined;
  }
}

export function createManagedVoice(db, config, fetcher = globalThis.fetch) {
  if (!config) return undefined;
  const { endpoint, model, apiKey, dailyLimit = 300, dailyIpLimit = 20 } = config;
  if ((endpoint !== HUNYUAN && endpoint !== HUNYUAN + '/') || model !== 'hy-asr-3.0-preview'
    || typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 8192 || /[\r\n]/.test(apiKey)
    || !Number.isSafeInteger(dailyLimit) || dailyLimit < 1
    || !Number.isSafeInteger(dailyIpLimit) || dailyIpLimit < 1) {
    throw new Error('Invalid asHub voice credential');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS managed_voice_quota (
    day INTEGER NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL,
    PRIMARY KEY (day, bucket)
  )`);
  const cleanup = db.prepare('DELETE FROM managed_voice_quota WHERE day < ?');
  const count = db.prepare('SELECT count FROM managed_voice_quota WHERE day=? AND bucket=?');
  const increment = db.prepare(`INSERT INTO managed_voice_quota VALUES (?,?,1)
    ON CONFLICT(day,bucket) DO UPDATE SET count=count+1`);
  function reserve(ip) {
    const day = Math.floor(Date.now() / 86_400_000);
    const bucket = createHash('sha256').update(`${day}:${ip}`).digest('hex');
    // All replicas using this database share the same budget across restarts.
    db.exec('BEGIN IMMEDIATE');
    try {
      cleanup.run(day);
      if ((count.get(day, 'total')?.count || 0) >= dailyLimit || (count.get(day, bucket)?.count || 0) >= dailyIpLimit) {
        throw fail(429, 'asHub 免费转写已达使用限额');
      }
      increment.run(day, 'total');
      increment.run(day, bucket);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  let active = 0;
  return async (input, ip, disconnect) => {
    const { mimeType, data } = input;
    if (mimeType !== 'audio/wav' || typeof data !== 'string' || !data.length) throw fail(400, '免费转写需要 WAV 录音');
    if (data.length > MAX_BASE64_BYTES) throw fail(413, '免费转写录音最长 60 秒');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_WAV_BYTES) throw fail(413, '免费转写录音最长 60 秒');
    if (!isPcmWav(bytes) || bytes.toString('base64') !== data) throw fail(400, '无效的 WAV 录音');
    if (active >= 4) throw fail(503, 'asHub 免费转写繁忙');
    disconnect.throwIfAborted();
    reserve(ip);
    active++;

    const signal = AbortSignal.any([disconnect, AbortSignal.timeout(65_000)]);
    try {
      const response = await fetcher(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, data }), redirect: 'error', signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error('Upstream transcription failed');
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > 128_000) throw new Error('Transcription response too large');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const result = JSON.parse(Buffer.concat(chunks).toString());
      const text = result?.status === 'completed' && result?.output?.text;
      if (typeof text !== 'string' || text.length > 20_000) throw new Error('Invalid transcription result');
      return { text: text.trim() };
    } catch {
      throw fail(502, 'asHub 免费转写暂不可用');
    } finally {
      active--;
    }
  };
}
