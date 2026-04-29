import React from 'react';
import {
  AbsoluteFill,
  Audio,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {loadFont as loadGeist} from '@remotion/google-fonts/Geist';
import {loadFont as loadGeistMono} from '@remotion/google-fonts/GeistMono';
import {getActiveRings, getAudio, useKickAnalysis} from './audio';

const geist = loadGeist('normal', {
  weights: ['400', '500', '600', '700', '800', '900'],
  subsets: ['latin'],
});
const geistMono = loadGeistMono('normal', {
  weights: ['400', '500', '600'],
  subsets: ['latin'],
});

const sansFamily = geist.fontFamily;
const monoFamily = geistMono.fontFamily;

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

export type Palette = {
  primary: string;
  secondary: string;
  deep: string;
  accent: string;
};

export type PaletteKey = 'violet' | 'mono' | 'ultra' | 'coronita' | 'funky-house';

export const PALETTES: Record<PaletteKey, Palette> = {
  violet: {
    primary: '#8b5cf6',
    secondary: '#a78bfa',
    deep: '#7c3aed',
    accent: '#d946ef',
  },
  mono: {
    primary: '#f0f0f5',
    secondary: '#c8c8d0',
    deep: '#64647a',
    accent: '#8b5cf6',
  },
  ultra: {
    primary: '#a78bfa',
    secondary: '#d946ef',
    deep: '#8b5cf6',
    accent: '#3b82f6',
  },
  coronita: {
    primary: '#ffed00',
    secondary: '#fff599',
    deep: '#b8a900',
    accent: '#ffffff',
  },
  'funky-house': {
    primary: '#ff4fa3',
    secondary: '#ffb3d1',
    deep: '#b8246e',
    accent: '#ffd166',
  },
};

export type RingsProps = {
  artist: string;
  title: string;
  catalog: string;
  year: string;
  audioUrl: string;
  paletteKey: PaletteKey;
};

const FIXED_INTENSITY = 0.7;
const DEFAULT_BPM = 128;

const VIEWBOX_W = 1920;
const VIEWBOX_H = 1080;
const CENTER_X = VIEWBOX_W * 0.68;
const CENTER_Y = VIEWBOX_H * 0.5;

const NP_PULSE_KEYFRAMES = `
@keyframes np-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(1.3); }
}
`;

const formatTime = (seconds: number): string => {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60)
    .toString()
    .padStart(2, '0');
  return `${m}:${s}`;
};

export const Rings: React.FC<RingsProps> = ({
  artist,
  title,
  catalog,
  year,
  audioUrl,
  paletteKey,
}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const palette = PALETTES[paletteKey] ?? PALETTES.violet;
  const t = frame / fps;
  const kickAnalysis = useKickAnalysis(audioUrl, fps);

  const estimatedBpm = kickAnalysis
    ? estimateBpmFromKicks(kickAnalysis.kickFrames, fps)
    : DEFAULT_BPM;
  const audio = getAudio(t, FIXED_INTENSITY, estimatedBpm);

  const trackCurrent = t;
  const trackDuration = durationInFrames / fps;

  const rings = kickAnalysis
    ? getActiveRings(
        frame,
        fps,
        kickAnalysis.kickFrames,
        kickAnalysis.kickStrengthByFrame,
      )
    : [];

  const recentKickStrength = (() => {
    if (!kickAnalysis) return 0;
    for (let i = kickAnalysis.kickFrames.length - 1; i >= 0; i--) {
      const kf = kickAnalysis.kickFrames[i]!;
      if (kf > frame) continue;
      const age = (frame - kf) / fps;
      if (age > 0.18) break;
      const decay = Math.max(0, 1 - age / 0.18);
      const strength = kickAnalysis.kickStrengthByFrame.get(kf) ?? 0;
      return decay * strength;
    }
    return 0;
  })();

  return (
    <AbsoluteFill style={{backgroundColor: '#06060a'}}>
      <style>{NP_PULSE_KEYFRAMES}</style>

      <Audio src={audioUrl} />

      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(circle at 68% 50%, ${palette.primary}1f 0%, ${palette.deep}0a 40%, transparent 70%)`,
        }}
      />

      <svg
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        preserveAspectRatio="xMidYMid slice"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
        }}
      >
        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <circle
            key={`g${i}`}
            cx={CENTER_X}
            cy={CENTER_Y}
            r={i * 75}
            fill="none"
            stroke={palette.primary}
            strokeOpacity={0.06}
            strokeWidth={1}
          />
        ))}

        <line
          x1={CENTER_X - 30}
          y1={CENTER_Y}
          x2={CENTER_X + 30}
          y2={CENTER_Y}
          stroke={palette.secondary}
          strokeOpacity={0.4}
          strokeWidth={1}
        />
        <line
          x1={CENTER_X}
          y1={CENTER_Y - 30}
          x2={CENTER_X}
          y2={CENTER_Y + 30}
          stroke={palette.secondary}
          strokeOpacity={0.4}
          strokeWidth={1}
        />
        <circle
          cx={CENTER_X}
          cy={CENTER_Y}
          r={6 + recentKickStrength * 20}
          fill={palette.secondary}
          opacity={0.5 + recentKickStrength * 0.5}
        />

        {rings.map((ring) => (
          <circle
            key={ring.bornFrame}
            cx={CENTER_X}
            cy={CENTER_Y}
            r={ring.r}
            fill="none"
            stroke={palette.primary}
            strokeOpacity={ring.alpha * 0.7}
            strokeWidth={ring.strokeWidth}
          />
        ))}

        {Array.from({length: 64}).map((_, i) => {
          const ang = (i / 64) * Math.PI * 2;
          const wave = Math.sin(t * 3 + i * 0.4);
          const len = 12 + (wave + 1) * 30 * (0.4 + audio.bass * 0.6);
          const r1 = 470;
          const r2 = r1 + len;
          const x1 = CENTER_X + Math.cos(ang) * r1;
          const y1 = CENTER_Y + Math.sin(ang) * r1;
          const x2 = CENTER_X + Math.cos(ang) * r2;
          const y2 = CENTER_Y + Math.sin(ang) * r2;
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={palette.primary}
              strokeOpacity={0.3 + wave * 0.4}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          );
        })}

        <g transform={`translate(${CENTER_X} ${CENTER_Y}) rotate(${t * 18})`}>
          {[0, 1, 2, 3, 4, 5].map((i) => {
            const ang = (i / 6) * Math.PI * 2;
            const r = 240 * (0.9 + audio.mid * 0.15);
            return (
              <circle
                key={i}
                cx={Math.cos(ang) * r}
                cy={Math.sin(ang) * r}
                r={4 + recentKickStrength * 8}
                fill={palette.secondary}
              />
            );
          })}
          <polygon
            points={[0, 1, 2, 3, 4, 5]
              .map((i) => {
                const ang = (i / 6) * Math.PI * 2;
                const r = 240 * (0.9 + audio.mid * 0.15);
                return `${Math.cos(ang) * r},${Math.sin(ang) * r}`;
              })
              .join(' ')}
            fill="none"
            stroke={palette.primary}
            strokeOpacity={0.45}
            strokeWidth={1}
          />
        </g>
      </svg>

      <TrackInfo
        artist={artist}
        title={title}
        current={trackCurrent}
        duration={trackDuration}
        palette={palette}
      />
      <LogoMark />
      <FrameMeta
        catalog={catalog}
        year={year}
        palette={palette}
        beat={audio.beat}
      />
    </AbsoluteFill>
  );
};

const TrackInfo: React.FC<{
  artist: string;
  title: string;
  current: number;
  duration: number;
  palette: Palette;
}> = ({artist, title, current, duration, palette}) => {
  const fg = '#f0f0f5';
  const muted = '#8a8a9a';
  const pct = Math.min(100, (current / Math.max(duration, 0.0001)) * 100);
  return (
    <div
      style={{
        position: 'absolute',
        left: 128,
        top: '50%',
        transform: 'translateY(-50%)',
        zIndex: 10,
        maxWidth: 1152,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          marginBottom: 67,
          fontFamily: monoFamily,
          fontSize: 26,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: muted,
        }}
      >
        <span
          style={{
            width: 19,
            height: 19,
            borderRadius: '50%',
            background: palette.primary,
            boxShadow: `0 0 29px ${palette.primary}`,
            animation: 'np-pulse 1.5s ease-in-out infinite',
            display: 'inline-block',
          }}
        />
        Now Playing
      </div>
      <div
        style={{
          fontFamily: monoFamily,
          fontSize: 31,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: palette.secondary,
          marginBottom: 34,
          fontWeight: 500,
        }}
      >
        {artist}
      </div>
      <div
        style={{
          fontFamily: sansFamily,
          fontSize: 134,
          lineHeight: 1.02,
          letterSpacing: '-0.03em',
          color: fg,
          fontWeight: 700,
          marginBottom: 86,
        }}
      >
        {title}
      </div>
      <div
        style={{
          width: 864,
          height: 5,
          background: 'rgba(255,255,255,0.08)',
          position: 'relative',
          marginBottom: 29,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${palette.primary}, ${palette.secondary})`,
            boxShadow: `0 0 19px ${palette.primary}`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: `${pct}%`,
            top: '50%',
            width: 19,
            height: 19,
            borderRadius: '50%',
            background: palette.secondary,
            boxShadow: `0 0 34px ${palette.primary}`,
            transform: 'translate(-50%, -50%)',
          }}
        />
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          width: 864,
          fontFamily: monoFamily,
          fontSize: 26,
          letterSpacing: '0.15em',
          color: muted,
        }}
      >
        <span style={{color: fg}}>{formatTime(current)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
};

const LogoMark: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      top: 80,
      right: 112,
      zIndex: 10,
      display: 'flex',
      alignItems: 'center',
      gap: 28,
      opacity: 0.85,
    }}
  >
    <img
      src={staticFile('kessey_white.png')}
      alt="Kessey Records"
      style={{width: 86, height: 86, objectFit: 'contain'}}
    />
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        fontFamily: monoFamily,
        fontSize: 24,
        letterSpacing: '0.25em',
        textTransform: 'uppercase',
        color: '#f0f0f5',
        lineHeight: 1.2,
      }}
    >
      <span style={{fontWeight: 600}}>Kessey</span>
      <span style={{color: '#8a8a9a'}}>Records</span>
    </div>
  </div>
);

const FrameMeta: React.FC<{
  catalog: string;
  year: string;
  palette: Palette;
  beat: number;
}> = ({catalog, year, palette, beat}) => {
  const muted = '#5a5a6a';
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: 128,
          bottom: 80,
          zIndex: 10,
          fontFamily: monoFamily,
          fontSize: 24,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: muted,
          display: 'flex',
          gap: 58,
        }}
      >
        <span>{catalog}</span>
        <span>{year}</span>
        <span style={{color: palette.secondary}}>VINYL · DIGITAL</span>
      </div>
      <div
        style={{
          position: 'absolute',
          right: 112,
          bottom: 80,
          zIndex: 10,
        }}
      >
        <span
          style={{
            display: 'inline-block',
            width: 16,
            height: 16,
            background: palette.primary,
            opacity: 0.4 + beat * 0.6,
            boxShadow: `0 0 ${8 + beat * 24}px ${palette.primary}`,
          }}
        />
      </div>
    </>
  );
};
