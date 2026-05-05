import {useEffect, useState, useMemo} from 'react';
import {getAudioData, AudioData} from '@remotion/media-utils';

// =============================================================================
// Audio analysis pipeline for the Rings visualiser.
//
// One FFT pass over the audio file computes:
//   - per-band envelopes (sub-bass, bass, low-mid, mid, high-mid, air)
//   - per-band onset streams (kicks, snares, hihats)
//   - a 48-bin log-spaced spectrum (per frame)
//   - estimated BPM (from kicks)
//
// All outputs are quantised to render frames so Rings.tsx can do O(1) lookups.
// =============================================================================

export type Onset = {frame: number; strength: number};

export type BandKey =
  | 'subBass'
  | 'bass'
  | 'lowMid'
  | 'mid'
  | 'highMid'
  | 'air';

const BANDS: Record<BandKey, {lowHz: number; highHz: number}> = {
  subBass: {lowHz: 20, highHz: 60},
  bass: {lowHz: 60, highHz: 200},
  lowMid: {lowHz: 200, highHz: 500},
  mid: {lowHz: 500, highHz: 2000},
  highMid: {lowHz: 2000, highHz: 6000},
  air: {lowHz: 6000, highHz: 16000},
};

const BAND_KEYS: BandKey[] = [
  'subBass',
  'bass',
  'lowMid',
  'mid',
  'highMid',
  'air',
];

// Envelope follower time constants (seconds) — attack/release per band group.
const ENV_TIMES: Record<BandKey, {attack: number; release: number}> = {
  subBass: {attack: 0.005, release: 0.12},
  bass: {attack: 0.005, release: 0.12},
  lowMid: {attack: 0.003, release: 0.08},
  mid: {attack: 0.003, release: 0.08},
  highMid: {attack: 0.001, release: 0.04},
  air: {attack: 0.001, release: 0.04},
};

// Per-band onset detector tuning. Higher multiplier = stricter peak picking.
const ONSET_TUNING: Record<
  BandKey,
  {multiplier: number; minGapSeconds: number; floor: number}
> = {
  subBass: {multiplier: 1.6, minGapSeconds: 0.12, floor: 0.05},
  bass: {multiplier: 1.6, minGapSeconds: 0.12, floor: 0.05},
  lowMid: {multiplier: 1.7, minGapSeconds: 0.1, floor: 0.05},
  mid: {multiplier: 1.8, minGapSeconds: 0.09, floor: 0.05},
  highMid: {multiplier: 1.6, minGapSeconds: 0.05, floor: 0.04},
  air: {multiplier: 1.5, minGapSeconds: 0.04, floor: 0.04},
};

export const SPECTRUM_BINS = 48;
const SPECTRUM_LOW_HZ = 30;
const SPECTRUM_HIGH_HZ = 16000;

const FFT_SIZE = 1024;
const HOP_SIZE = 256;
const ADAPTIVE_WINDOW_SECONDS = 1.2;

// Percentile used for per-band normalisation (95th).
const NORMALISE_PERCENTILE = 0.95;
// Floor applied so quiet tracks still hit the top of the curve occasionally.
const NORMALISE_MIN_REFERENCE = 1e-4;

export type FullAnalysis = {
  fps: number;
  totalFrames: number;
  bpm: number;
  bands: Record<BandKey, Float32Array>;
  // Flat row-major: index = frame * SPECTRUM_BINS + bin.
  spectrum: Float32Array;
  // Event streams sorted by frame ascending.
  kicks: Onset[];
  snares: Onset[];
  hihats: Onset[];
  // Maps for fast strength lookup at a given frame.
  kickStrengthByFrame: Map<number, number>;
  snareStrengthByFrame: Map<number, number>;
  hihatStrengthByFrame: Map<number, number>;
};

// =============================================================================
// Public helpers consumed by Rings.tsx
// =============================================================================

export type Beat = {
  t: number;
  bass: number;
  mid: number;
  beat: number;
};

export const getAudio = (t: number, intensity: number, bpm: number): Beat => {
  const beatPeriod = 60 / bpm;
  const phase = (t % beatPeriod) / beatPeriod;
  const env = (1 - phase) ** 3;
  const bass = (0.55 + 0.45 * env) * intensity;
  const mid =
    (0.35 + 0.35 * Math.abs(Math.sin(t * 2 * Math.PI * 1.7)) + 0.25 * env) *
    intensity;
  const beat = env * intensity;
  return {t, bass, mid, beat};
};

export type Ring = {
  bornFrame: number;
  age: number;
  r: number;
  alpha: number;
  strokeWidth: number;
};

const RING_LIFE_SECONDS = 4;
const RING_GROWTH_PER_SECOND = 220;
const RING_BIRTH_RADIUS = 30;

export const getActiveRings = (
  frame: number,
  fps: number,
  kickFrames: number[],
  kickStrengthByFrame: Map<number, number>,
): Ring[] => {
  const rings: Ring[] = [];
  for (let i = kickFrames.length - 1; i >= 0; i--) {
    const bornFrame = kickFrames[i]!;
    if (bornFrame > frame) continue;
    const age = (frame - bornFrame) / fps;
    if (age >= RING_LIFE_SECONDS) break;
    const strength = kickStrengthByFrame.get(bornFrame) ?? 0.7;
    const r = RING_BIRTH_RADIUS + age * RING_GROWTH_PER_SECOND;
    const alpha = Math.max(0, 1 - age / RING_LIFE_SECONDS) * strength;
    const strokeWidth = Math.max(0.1, 2 - age * 0.4);
    rings.push({bornFrame, age, r, alpha, strokeWidth});
  }
  return rings;
};

export const getRecentOnsetStrength = (
  frame: number,
  fps: number,
  onsets: Onset[],
  decaySeconds: number,
): number => {
  for (let i = onsets.length - 1; i >= 0; i--) {
    const o = onsets[i]!;
    if (o.frame > frame) continue;
    const age = (frame - o.frame) / fps;
    if (age > decaySeconds) return 0;
    const decay = Math.max(0, 1 - age / decaySeconds);
    return decay * o.strength;
  }
  return 0;
};

export const countOnsetsUpTo = (frame: number, onsets: Onset[]): number => {
  // Binary search for first onset > frame.
  let lo = 0;
  let hi = onsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (onsets[mid]!.frame <= frame) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

// =============================================================================
// Backwards-compatible kick-only API (used elsewhere in the codebase).
// =============================================================================

type KickAnalysis = {
  kickFrames: number[];
  kickStrengthByFrame: Map<number, number>;
};

const EMPTY_KICK: KickAnalysis = {
  kickFrames: [],
  kickStrengthByFrame: new Map(),
};

// =============================================================================
// Analysis core
// =============================================================================

const buildAnalysis = (audioData: AudioData, fps: number): FullAnalysis => {
  const channel = audioData.channelWaveforms[0];
  const sampleRate = audioData.sampleRate;
  const totalFrames = Math.max(
    1,
    Math.ceil((channel?.length ?? 0) / sampleRate * fps),
  );

  const empty = makeEmptyAnalysis(totalFrames, fps);
  if (!channel || channel.length < FFT_SIZE) return empty;

  const numHops = Math.floor((channel.length - FFT_SIZE) / HOP_SIZE) + 1;
  if (numHops <= 1) return empty;

  // ---- Pre-compute helpers ------------------------------------------------
  const window = hannWindow(FFT_SIZE);
  const halfFft = FFT_SIZE / 2;

  // Band frequency-bin ranges.
  const bandBinRanges: Record<BandKey, {lo: number; hi: number}> = {} as Record<
    BandKey,
    {lo: number; hi: number}
  >;
  for (const key of BAND_KEYS) {
    const {lowHz, highHz} = BANDS[key]!;
    bandBinRanges[key] = {
      lo: Math.max(1, Math.floor((lowHz * FFT_SIZE) / sampleRate)),
      hi: Math.min(halfFft, Math.ceil((highHz * FFT_SIZE) / sampleRate)),
    };
  }

  // 48 log-spaced spectrum bin ranges.
  const spectrumBinRanges = new Array<{lo: number; hi: number}>(SPECTRUM_BINS);
  {
    const logLow = Math.log(SPECTRUM_LOW_HZ);
    const logHigh = Math.log(Math.min(SPECTRUM_HIGH_HZ, sampleRate / 2 - 1));
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const f0 = Math.exp(logLow + (logHigh - logLow) * (i / SPECTRUM_BINS));
      const f1 = Math.exp(
        logLow + (logHigh - logLow) * ((i + 1) / SPECTRUM_BINS),
      );
      spectrumBinRanges[i] = {
        lo: Math.max(1, Math.floor((f0 * FFT_SIZE) / sampleRate)),
        hi: Math.min(halfFft, Math.max(2, Math.ceil((f1 * FFT_SIZE) / sampleRate))),
      };
    }
  }

  // Per-hop magnitudes per band (raw RMS) and per spectrum bin.
  const hopBand: Record<BandKey, Float32Array> = {} as Record<
    BandKey,
    Float32Array
  >;
  for (const key of BAND_KEYS) hopBand[key] = new Float32Array(numHops);
  const hopSpectrum = new Float32Array(numHops * SPECTRUM_BINS);

  // Per-hop spectral flux per band (for onset detection).
  const hopFlux: Record<BandKey, Float32Array> = {} as Record<
    BandKey,
    Float32Array
  >;
  for (const key of BAND_KEYS) hopFlux[key] = new Float32Array(numHops);

  // Previous magnitudes per band (one running value per band, for flux).
  const prevBandMag: Record<BandKey, number> = {
    subBass: 0,
    bass: 0,
    lowMid: 0,
    mid: 0,
    highMid: 0,
    air: 0,
  };

  // ---- Single FFT pass ----------------------------------------------------
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  const mag = new Float64Array(halfFft + 1);

  for (let hop = 0; hop < numHops; hop++) {
    const start = hop * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      real[i] = channel[start + i]! * window[i]!;
      imag[i] = 0;
    }
    fftInPlace(real, imag);

    // Compute magnitudes once.
    for (let bin = 1; bin <= halfFft; bin++) {
      const re = real[bin]!;
      const im = imag[bin]!;
      mag[bin] = Math.sqrt(re * re + im * im);
    }

    // Per-band sum (for envelope) + flux (positive diff).
    for (const key of BAND_KEYS) {
      const {lo, hi} = bandBinRanges[key]!;
      let sum = 0;
      for (let bin = lo; bin <= hi; bin++) sum += mag[bin]!;
      const avg = hi >= lo ? sum / (hi - lo + 1) : 0;
      hopBand[key]![hop] = avg;
      const diff = avg - prevBandMag[key]!;
      hopFlux[key]![hop] = diff > 0 ? diff : 0;
      prevBandMag[key] = avg;
    }

    // Log-spaced spectrum bins (mean magnitude in each band).
    const specBase = hop * SPECTRUM_BINS;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const {lo, hi} = spectrumBinRanges[i]!;
      let sum = 0;
      const count = hi - lo + 1;
      for (let bin = lo; bin <= hi; bin++) sum += mag[bin]!;
      hopSpectrum[specBase + i] = count > 0 ? sum / count : 0;
    }
  }

  // ---- Reduce hops to render frames (max within each frame) ---------------
  const hopDuration = HOP_SIZE / sampleRate;

  // Per-frame band envelopes (raw, before envelope follower).
  const rawBand: Record<BandKey, Float32Array> = {} as Record<
    BandKey,
    Float32Array
  >;
  for (const key of BAND_KEYS) rawBand[key] = new Float32Array(totalFrames);

  // Per-frame spectrum (max-pooled across hops in the frame).
  const rawSpectrum = new Float32Array(totalFrames * SPECTRUM_BINS);

  // Per-frame max flux per band (for onset detection, hop-aligned to frames).
  const rawFlux: Record<BandKey, Float32Array> = {} as Record<
    BandKey,
    Float32Array
  >;
  for (const key of BAND_KEYS) rawFlux[key] = new Float32Array(totalFrames);

  // Map hop -> frame, accumulate per-frame max.
  for (let hop = 0; hop < numHops; hop++) {
    const seconds = hop * hopDuration;
    const frame = Math.floor(seconds * fps);
    if (frame < 0 || frame >= totalFrames) continue;

    for (const key of BAND_KEYS) {
      const v = hopBand[key]![hop]!;
      if (v > rawBand[key]![frame]!) rawBand[key]![frame] = v;
      const f = hopFlux[key]![hop]!;
      if (f > rawFlux[key]![frame]!) rawFlux[key]![frame] = f;
    }

    const specBase = hop * SPECTRUM_BINS;
    const frameBase = frame * SPECTRUM_BINS;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const v = hopSpectrum[specBase + i]!;
      if (v > rawSpectrum[frameBase + i]!) rawSpectrum[frameBase + i] = v;
    }
  }

  // Forward-fill any frames with zero (gaps when hop rate < frame rate is rare,
  // but if the audio is short it can happen — keeps the envelope continuous).
  for (const key of BAND_KEYS) forwardFill(rawBand[key]!);
  forwardFillStrided(rawSpectrum, SPECTRUM_BINS);

  // ---- Per-band envelope follower (attack/release) -----------------------
  const bands: Record<BandKey, Float32Array> = {} as Record<
    BandKey,
    Float32Array
  >;
  for (const key of BAND_KEYS) {
    const env = applyEnvelope(rawBand[key]!, ENV_TIMES[key]!, fps);
    bands[key] = env;
  }

  // ---- Per-band normalisation (95th percentile) --------------------------
  for (const key of BAND_KEYS) {
    const ref = percentile(bands[key]!, NORMALISE_PERCENTILE);
    const denom = Math.max(ref, NORMALISE_MIN_REFERENCE);
    const arr = bands[key]!;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]! / denom;
      arr[i] = v > 1 ? 1 : v < 0 ? 0 : v;
    }
  }

  // ---- Spectrum normalisation (single global percentile) -----------------
  {
    const ref = percentile(rawSpectrum, NORMALISE_PERCENTILE);
    const denom = Math.max(ref, NORMALISE_MIN_REFERENCE);
    for (let i = 0; i < rawSpectrum.length; i++) {
      const v = rawSpectrum[i]! / denom;
      rawSpectrum[i] = v > 1 ? 1 : v < 0 ? 0 : v;
    }
  }

  // ---- Onset picking per band (kicks/snares/hihats) ----------------------
  const adaptiveWindow = Math.max(
    8,
    Math.round(ADAPTIVE_WINDOW_SECONDS / hopDuration),
  );

  const pickFor = (bandKey: BandKey): Onset[] => {
    const tuning = ONSET_TUNING[bandKey]!;
    const minGapHops = Math.max(2, Math.round(tuning.minGapSeconds / hopDuration));
    const onsetsHop = pickPeaks(
      hopFlux[bandKey]!,
      adaptiveWindow,
      minGapHops,
      tuning.multiplier,
      tuning.floor,
    );
    if (onsetsHop.length === 0) return [];

    let maxStrength = 0;
    for (const o of onsetsHop) if (o.strength > maxStrength) maxStrength = o.strength;

    const minGapFrames = Math.max(2, Math.round(tuning.minGapSeconds * fps));
    const out: Onset[] = [];
    let lastFrame = -Infinity;
    for (const o of onsetsHop) {
      const seconds = o.hop * hopDuration;
      const frame = Math.floor(seconds * fps);
      if (frame >= totalFrames) break;
      if (frame - lastFrame < minGapFrames) {
        const last = out[out.length - 1];
        if (last && o.strength > last.strength * maxStrength) {
          last.frame = frame;
          last.strength = Math.max(0.35, Math.min(1, o.strength / maxStrength));
          lastFrame = frame;
        }
        continue;
      }
      const normalized =
        maxStrength > 0 ? Math.min(1, o.strength / maxStrength) : 0.7;
      out.push({frame, strength: Math.max(0.35, normalized)});
      lastFrame = frame;
    }
    return out;
  };

  const kicks = pickFor('bass');
  const snares = pickFor('mid');
  const hihats = pickFor('air');

  // ---- BPM estimation (from kicks) ---------------------------------------
  const bpm = estimateBpmFromKicks(kicks.map((o) => o.frame), fps);

  // ---- Strength lookup maps ----------------------------------------------
  const kickStrengthByFrame = new Map<number, number>();
  for (const o of kicks) kickStrengthByFrame.set(o.frame, o.strength);
  const snareStrengthByFrame = new Map<number, number>();
  for (const o of snares) snareStrengthByFrame.set(o.frame, o.strength);
  const hihatStrengthByFrame = new Map<number, number>();
  for (const o of hihats) hihatStrengthByFrame.set(o.frame, o.strength);

  return {
    fps,
    totalFrames,
    bpm,
    bands,
    spectrum: rawSpectrum,
    kicks,
    snares,
    hihats,
    kickStrengthByFrame,
    snareStrengthByFrame,
    hihatStrengthByFrame,
  };
};

const makeEmptyAnalysis = (totalFrames: number, fps: number): FullAnalysis => {
  const bands: Record<BandKey, Float32Array> = {} as Record<
    BandKey,
    Float32Array
  >;
  for (const key of BAND_KEYS) bands[key] = new Float32Array(totalFrames);
  return {
    fps,
    totalFrames,
    bpm: 128,
    bands,
    spectrum: new Float32Array(totalFrames * SPECTRUM_BINS),
    kicks: [],
    snares: [],
    hihats: [],
    kickStrengthByFrame: new Map(),
    snareStrengthByFrame: new Map(),
    hihatStrengthByFrame: new Map(),
  };
};

// =============================================================================
// Math helpers
// =============================================================================

const applyEnvelope = (
  raw: Float32Array,
  {attack, release}: {attack: number; release: number},
  fps: number,
): Float32Array => {
  const out = new Float32Array(raw.length);
  const attackAlpha = 1 - Math.exp(-1 / Math.max(1e-6, attack * fps));
  const releaseAlpha = 1 - Math.exp(-1 / Math.max(1e-6, release * fps));
  let env = 0;
  for (let i = 0; i < raw.length; i++) {
    const target = raw[i]!;
    const alpha = target > env ? attackAlpha : releaseAlpha;
    env = env + (target - env) * alpha;
    out[i] = env;
  }
  return out;
};

const percentile = (arr: Float32Array, p: number): number => {
  if (arr.length === 0) return 0;
  // Sample to keep cost bounded on long tracks (every Nth value is enough for p95).
  const stride = Math.max(1, Math.floor(arr.length / 8192));
  const sample: number[] = [];
  for (let i = 0; i < arr.length; i += stride) sample.push(arr[i]!);
  sample.sort((a, b) => a - b);
  const idx = Math.floor((sample.length - 1) * p);
  return sample[Math.max(0, Math.min(sample.length - 1, idx))]!;
};

const forwardFill = (arr: Float32Array): void => {
  let last = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === 0) arr[i] = last;
    else last = arr[i]!;
  }
};

const forwardFillStrided = (arr: Float32Array, stride: number): void => {
  for (let lane = 0; lane < stride; lane++) {
    let last = 0;
    for (let i = lane; i < arr.length; i += stride) {
      if (arr[i] === 0) arr[i] = last;
      else last = arr[i]!;
    }
  }
};

type HopOnset = {hop: number; strength: number};

const pickPeaks = (
  flux: Float32Array,
  windowSize: number,
  minGap: number,
  multiplier: number,
  floor: number,
): HopOnset[] => {
  const onsets: HopOnset[] = [];
  if (flux.length < 3) return onsets;

  const sorted = new Float32Array(windowSize);
  let lastOnsetHop = -Infinity;

  for (let i = 1; i < flux.length - 1; i++) {
    const value = flux[i]!;
    if (value <= flux[i - 1]! || value < flux[i + 1]!) continue;

    const winStart = Math.max(0, i - Math.floor(windowSize / 2));
    const winEnd = Math.min(flux.length, winStart + windowSize);
    const actualWindow = winEnd - winStart;
    for (let k = 0; k < actualWindow; k++) {
      sorted[k] = flux[winStart + k]!;
    }
    const slice = sorted.subarray(0, actualWindow);
    const median = quickMedian(slice);

    let sumSquaredDev = 0;
    for (let k = 0; k < actualWindow; k++) {
      const dev = slice[k]! - median;
      sumSquaredDev += dev * dev;
    }
    const std = Math.sqrt(sumSquaredDev / actualWindow);
    const threshold = Math.max(floor, median + multiplier * std);

    if (value < threshold) continue;
    if (i - lastOnsetHop < minGap) {
      const last = onsets[onsets.length - 1];
      if (last && value > last.strength) {
        last.hop = i;
        last.strength = value;
        lastOnsetHop = i;
      }
      continue;
    }

    onsets.push({hop: i, strength: value});
    lastOnsetHop = i;
  }

  return onsets;
};

const quickMedian = (arr: Float32Array): number => {
  const copy = Array.from(arr);
  copy.sort((a, b) => a - b);
  const mid = Math.floor(copy.length / 2);
  if (copy.length % 2 === 0) {
    return (copy[mid - 1]! + copy[mid]!) / 2;
  }
  return copy[mid]!;
};

const hannWindow = (size: number): Float32Array => {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
};

const fftInPlace = (real: Float64Array, imag: Float64Array): void => {
  const n = real.length;
  const bits = Math.log2(n);
  if (!Number.isInteger(bits)) {
    throw new Error(`FFT size must be power of 2, got ${n}`);
  }

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j]!, real[i]!];
      [imag[i], imag[j]] = [imag[j]!, imag[i]!];
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angleStep = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const angle = angleStep * k;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const evenIdx = start + k;
        const oddIdx = evenIdx + half;
        const tRe = real[oddIdx]! * cos - imag[oddIdx]! * sin;
        const tIm = real[oddIdx]! * sin + imag[oddIdx]! * cos;
        real[oddIdx] = real[evenIdx]! - tRe;
        imag[oddIdx] = imag[evenIdx]! - tIm;
        real[evenIdx] = real[evenIdx]! + tRe;
        imag[evenIdx] = imag[evenIdx]! + tIm;
      }
    }
  }
};

const estimateBpmFromKicks = (kickFrames: number[], fps: number): number => {
  if (kickFrames.length < 4) return 128;
  const intervals: number[] = [];
  for (let i = 1; i < kickFrames.length; i++) {
    intervals.push(kickFrames[i]! - kickFrames[i - 1]!);
  }
  intervals.sort((a, b) => a - b);
  const trimStart = Math.floor(intervals.length * 0.2);
  const trimEnd = Math.ceil(intervals.length * 0.8);
  const trimmed = intervals.slice(trimStart, trimEnd);
  if (trimmed.length === 0) return 128;
  const medianFrameInterval =
    trimmed.reduce((sum, v) => sum + v, 0) / trimmed.length;
  if (medianFrameInterval <= 0) return 128;
  let bpm = (60 * fps) / medianFrameInterval;
  while (bpm < 90) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return bpm;
};

// =============================================================================
// Hooks
// =============================================================================

export const useFullAnalysis = (
  audioUrl: string,
  fps: number,
): FullAnalysis | null => {
  const [audioData, setAudioData] = useState<AudioData | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAudioData(null);
    getAudioData(audioUrl)
      .then((data) => {
        if (!cancelled) setAudioData(data);
      })
      .catch((err) => {
        console.error('Failed to load audio data:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [audioUrl]);

  return useMemo(() => {
    if (!audioData) return null;
    return buildAnalysis(audioData, fps);
  }, [audioData, fps]);
};

// Backwards-compat: kick-only API some legacy code paths may still call.
export const useKickAnalysis = (
  audioUrl: string,
  fps: number,
): KickAnalysis | null => {
  const full = useFullAnalysis(audioUrl, fps);
  return useMemo(() => {
    if (!full) return null;
    if (full.kicks.length === 0) return EMPTY_KICK;
    return {
      kickFrames: full.kicks.map((o) => o.frame),
      kickStrengthByFrame: full.kickStrengthByFrame,
    };
  }, [full]);
};
