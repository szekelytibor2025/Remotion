import {useEffect, useState, useMemo} from 'react';
import {getAudioData, AudioData} from '@remotion/media-utils';

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

type KickAnalysis = {
  kickFrames: number[];
  kickStrengthByFrame: Map<number, number>;
};

const EMPTY_ANALYSIS: KickAnalysis = {
  kickFrames: [],
  kickStrengthByFrame: new Map(),
};

const FFT_SIZE = 1024;
const HOP_SIZE = 256;
const BASS_LOW_HZ = 40;
const BASS_HIGH_HZ = 180;
const MIN_KICK_GAP_SECONDS = 0.12;
const ADAPTIVE_WINDOW_SECONDS = 1.2;
const ADAPTIVE_MULTIPLIER = 1.6;
const ADAPTIVE_FLOOR = 0.05;

const detectKickFrames = (audioData: AudioData, fps: number): KickAnalysis => {
  const channel = audioData.channelWaveforms[0];
  if (!channel) return EMPTY_ANALYSIS;

  const sampleRate = audioData.sampleRate;
  const flux = computeBassSpectralFlux(channel, sampleRate);
  if (flux.length === 0) return EMPTY_ANALYSIS;

  const hopDuration = HOP_SIZE / sampleRate;
  const adaptiveWindow = Math.max(
    8,
    Math.round(ADAPTIVE_WINDOW_SECONDS / hopDuration),
  );
  const minGapHops = Math.max(2, Math.round(MIN_KICK_GAP_SECONDS / hopDuration));

  const onsets = pickPeaks(flux, adaptiveWindow, minGapHops);
  if (onsets.length === 0) return EMPTY_ANALYSIS;

  let maxStrength = 0;
  for (const onset of onsets) {
    if (onset.strength > maxStrength) maxStrength = onset.strength;
  }

  const kickFrames: number[] = [];
  const kickStrengthByFrame = new Map<number, number>();
  let lastFrame = -Infinity;
  const minGapFrames = Math.max(2, Math.round(MIN_KICK_GAP_SECONDS * fps));

  for (const onset of onsets) {
    const sampleIndex = onset.hop * HOP_SIZE;
    const seconds = sampleIndex / sampleRate;
    const frame = Math.floor(seconds * fps);
    if (frame - lastFrame < minGapFrames) continue;
    const normalized =
      maxStrength > 0 ? Math.min(1, onset.strength / maxStrength) : 0.7;
    const strength = Math.max(0.35, normalized);
    kickFrames.push(frame);
    kickStrengthByFrame.set(frame, strength);
    lastFrame = frame;
  }

  return {kickFrames, kickStrengthByFrame};
};

const computeBassSpectralFlux = (
  channel: Float32Array,
  sampleRate: number,
): Float32Array => {
  const numHops = Math.max(0, Math.floor((channel.length - FFT_SIZE) / HOP_SIZE) + 1);
  if (numHops <= 1) return new Float32Array(0);

  const window = hannWindow(FFT_SIZE);
  const lowBin = Math.max(1, Math.floor((BASS_LOW_HZ * FFT_SIZE) / sampleRate));
  const highBin = Math.min(
    FFT_SIZE / 2,
    Math.ceil((BASS_HIGH_HZ * FFT_SIZE) / sampleRate),
  );

  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  const prevMagnitudes = new Float64Array(highBin - lowBin + 1);
  const flux = new Float32Array(numHops);

  for (let hop = 0; hop < numHops; hop++) {
    const start = hop * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      real[i] = channel[start + i]! * window[i]!;
      imag[i] = 0;
    }
    fftInPlace(real, imag);

    let sumPositive = 0;
    for (let bin = lowBin; bin <= highBin; bin++) {
      const re = real[bin]!;
      const im = imag[bin]!;
      const magnitude = Math.sqrt(re * re + im * im);
      const idx = bin - lowBin;
      const diff = magnitude - prevMagnitudes[idx]!;
      if (diff > 0) sumPositive += diff;
      prevMagnitudes[idx] = magnitude;
    }
    flux[hop] = sumPositive;
  }

  return flux;
};

type Onset = {hop: number; strength: number};

const pickPeaks = (
  flux: Float32Array,
  windowSize: number,
  minGap: number,
): Onset[] => {
  const onsets: Onset[] = [];
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
    const threshold = Math.max(
      ADAPTIVE_FLOOR,
      median + ADAPTIVE_MULTIPLIER * std,
    );

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

export const useKickAnalysis = (
  audioUrl: string,
  fps: number,
): KickAnalysis | null => {
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
    return detectKickFrames(audioData, fps);
  }, [audioData, fps]);
};
