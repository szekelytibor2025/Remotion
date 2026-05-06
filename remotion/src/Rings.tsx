import React from 'react';
import {
  AbsoluteFill,
  Audio,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {
  countOnsetsUpTo,
  getRecentOnsetStrength,
  SPECTRUM_BINS,
  useFullAnalysis,
} from './audio';

export type PaletteKey = 'default';

export type RingsProps = {
  artist: string;
  title: string;
  catalog: string;
  year: string;
  audioUrl: string;
  paletteKey: PaletteKey;
  durationInSeconds?: number;
};

const VIEWBOX_W = 1920;
const VIEWBOX_H = 1080;

const ORB_CX = 1380;
const ORB_CY = 540;

const KESSEY_PURPLE = '#9D00FF';
const KESSEY_PURPLE_GLOW = '#B833FF';
const KESSEY_PURPLE_DEEP = '#6B00B0';
const KESSEY_BORDER = '#2C2A38';
const KESSEY_SMOKE_MID = '#2C2A38';
const TEXT_PRIMARY = '#FFFFFF';
const TEXT_SECONDARY = '#C9C9D1';
const TEXT_MUTED = '#6B6B78';

const FONT_DISPLAY = "'Druk Wide', 'Arial Black', Impact, sans-serif";
const FONT_BODY =
  "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";
const FONT_MONO = "'IBM Plex Mono', ui-monospace, monospace";

const FONT_FACES_CSS = `
@font-face {
  font-family: 'Druk Wide';
  src: url('${staticFile('fonts/druk-wide-bold.ttf')}') format('truetype');
  font-weight: 700;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'IBM Plex Sans';
  src: url('${staticFile('fonts/IBMPlexSans.ttf')}') format('truetype-variations');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'IBM Plex Mono';
  src: url('${staticFile('fonts/IBMPlexMono-Regular.ttf')}') format('truetype');
  font-weight: 400;
  font-style: normal;
  font-display: block;
}
@keyframes kr-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.5; transform: scale(1.25); }
}
@keyframes kr-orb-1 {
  0%   { transform: translate(0,0) scale(1); }
  100% { transform: translate(60px, 80px) scale(1.08); }
}
@keyframes kr-orb-2 {
  0%   { transform: translate(0,0) scale(1); }
  100% { transform: translate(-80px, -60px) scale(1.12); }
}
`;

type AudioState = {
  // Sustained band envelopes (0..1, normalised per-track via 95th percentile).
  bass: number; // 60–200 Hz — drives orb radius, core flash
  subBass: number; // 20–60 Hz — sub-frequency haze
  mid: number; // 500–2000 Hz — outer haze breath, ring spread
  high: number; // 6–16 kHz — sparks density / brightness
  // Onset transients with short decay (kick, snare, hihat).
  kickHit: number;
  snareHit: number;
  hihatHit: number;
  // Per-frame log-spaced spectrum, 48 bins.
  spectrum: Float32Array;
  // Number of kicks observed up to and including this frame.
  barCount: number;
};

const EMPTY_SPECTRUM = new Float32Array(SPECTRUM_BINS);

const fmt = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const fmtNeg = (seconds: number): string => '-' + fmt(seconds);

const GLOW_MULT = 1;

// Onset decay constants (seconds). Drum hits visibly punch, then settle.
const KICK_DECAY = 0.18;
const SNARE_DECAY = 0.16;
const HIHAT_DECAY = 0.08;

export const Rings: React.FC<RingsProps> = ({
  artist,
  title,
  catalog,
  audioUrl,
}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const analysis = useFullAnalysis(audioUrl, fps);
  const t = frame / fps;

  const audio: AudioState = (() => {
    if (!analysis) {
      return {
        bass: 0,
        subBass: 0,
        mid: 0,
        high: 0,
        kickHit: 0,
        snareHit: 0,
        hihatHit: 0,
        spectrum: EMPTY_SPECTRUM,
        barCount: 0,
      };
    }
    const safeFrame = Math.min(frame, analysis.totalFrames - 1);
    const base = safeFrame * SPECTRUM_BINS;
    // Float32Array views are zero-copy and safe to read directly.
    const spectrum = analysis.spectrum.subarray(base, base + SPECTRUM_BINS);
    return {
      bass: analysis.bands.bass[safeFrame] ?? 0,
      subBass: analysis.bands.subBass[safeFrame] ?? 0,
      mid: analysis.bands.mid[safeFrame] ?? 0,
      high: analysis.bands.air[safeFrame] ?? 0,
      kickHit: getRecentOnsetStrength(frame, fps, analysis.kicks, KICK_DECAY),
      snareHit: getRecentOnsetStrength(frame, fps, analysis.snares, SNARE_DECAY),
      hihatHit: getRecentOnsetStrength(frame, fps, analysis.hihats, HIHAT_DECAY),
      spectrum,
      barCount: countOnsetsUpTo(frame, analysis.kicks),
    };
  })();

  const trackCurrent = t;
  const trackDuration = durationInFrames / fps;

  return (
    <AbsoluteFill style={{backgroundColor: '#06060A', fontFamily: FONT_BODY}}>
      <style>{FONT_FACES_CSS}</style>

      <Audio src={audioUrl} />

      {/* Backdrop — black & white photo */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `url(${staticFile('background.jpg')})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          filter: 'grayscale(1) contrast(1.1) brightness(0.55)',
        }}
      />

      {/* Left-side darkening: gets darker as we move from center to the
          left edge so the chrome text stays legible. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'linear-gradient(to left, rgba(0,0,0,0) 50%, rgba(0,0,0,0.55) 75%, rgba(0,0,0,0.9) 100%)',
        }}
      />

      {/* Subtle deep-purple wash over the top for brand mood */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(120% 80% at 70% 50%, rgba(21,16,42,0.45) 0%, rgba(6,6,10,0.6) 55%, rgba(0,0,0,0.85) 100%)',
          mixBlendMode: 'multiply',
        }}
      />

      {/* Ambient bg orbs */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            position: 'absolute',
            width: 900,
            height: 900,
            borderRadius: 999,
            filter: 'blur(140px)',
            opacity: 0.55,
            mixBlendMode: 'screen',
            top: -240,
            left: -200,
            background: `radial-gradient(circle, ${KESSEY_PURPLE_DEEP} 0%, transparent 65%)`,
            transform: `translate(${
              30 + 30 * Math.sin(t * 0.22)
            }px, ${40 + 40 * Math.cos(t * 0.18)}px) scale(${
              1.04 + 0.04 * Math.sin(t * 0.22)
            })`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            width: 900,
            height: 900,
            borderRadius: 999,
            filter: 'blur(140px)',
            opacity: 0.55,
            mixBlendMode: 'screen',
            bottom: -300,
            right: -260,
            background: `radial-gradient(circle, ${KESSEY_PURPLE} 0%, transparent 65%)`,
            transform: `translate(${
              -40 - 40 * Math.sin(t * 0.2)
            }px, ${-30 - 30 * Math.cos(t * 0.16)}px) scale(${
              1.06 + 0.06 * Math.sin(t * 0.2)
            })`,
          }}
        />
      </div>

      {/* Visualiser SVG */}
      <OrbViz audio={audio} />

      {/* Chrome */}
      <Chrome
        artist={artist}
        title={title}
        catalog={catalog}
        audio={audio}
        played={trackCurrent}
        total={trackDuration}
      />

      {/* Vignette */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(140% 100% at 50% 50%, transparent 50%, rgba(0,0,0,0.6) 100%)',
        }}
      />

      <style>{`
        body { color: ${TEXT_PRIMARY}; }
      `}</style>
    </AbsoluteFill>
  );
};

const OrbViz: React.FC<{audio: AudioState}> = ({audio}) => {
  const {bass, subBass, mid, high, kickHit, snareHit, hihatHit, spectrum, barCount} =
    audio;
  const baseR = 280;
  // Sustained bass envelope drives the slow breathing; a kick transient adds a
  // snappy radius pulse on top so each hit is visible.
  const r = baseR + bass * 70 + kickHit * 60;
  const cx = ORB_CX;
  const cy = ORB_CY;
  // Sub-bass fattens the haze, mids breathe slower around it.
  const hazeR = r + 240 + mid * 120 + subBass * 100;
  const coreR = 70 + kickHit * 70 + bass * 30;

  // Concentric rings — base radius reacts to bass envelope, snare hits push an
  // extra spread (a brief outer expansion, like a clap echoing past the orb).
  const rings = [];
  for (let i = 0; i < 6; i++) {
    const rr = r + i * 36 + mid * 10 + snareHit * (24 + i * 18);
    rings.push(
      <circle
        key={`ring-${i}`}
        cx={cx}
        cy={cy}
        r={rr}
        fill="none"
        stroke={KESSEY_PURPLE}
        strokeOpacity={(0.55 - i * 0.08) * (1 + snareHit * 0.4)}
        strokeWidth={i === 0 ? 2 + snareHit * 1.5 : 1}
        style={{
          filter: `drop-shadow(0 0 ${10 * GLOW_MULT}px rgba(157,0,255,${
            0.6 - i * 0.07
          }))`,
        }}
      />,
    );
  }

  // Radial spikes are driven by the actual log-spaced spectrum.
  const spikes = [];
  const N = 96;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const v = spectrum[i % spectrum.length] ?? 0;
    const inner = r - 6;
    const outer = r + 12 + v * (140 + bass * 60 + kickHit * 80);
    const x1 = cx + Math.cos(a) * inner;
    const y1 = cy + Math.sin(a) * inner;
    const x2 = cx + Math.cos(a) * outer;
    const y2 = cy + Math.sin(a) * outer;
    spikes.push(
      <line
        key={`s-${i}`}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={KESSEY_PURPLE_GLOW}
        strokeOpacity={0.45 + v * 0.5}
        strokeWidth={1.2}
      />,
    );
  }

  // Sparks: hihats spawn extras and brighten the swarm. The visible count
  // grows with hihatHit so on a fast hat pattern the orb glitters.
  const sparkCount = Math.round(24 + hihatHit * 36 + high * 20);
  const sparks = [];
  for (let i = 0; i < sparkCount; i++) {
    const a = (i / sparkCount) * Math.PI * 2 + barCount * 0.05;
    const seed = Math.abs(Math.sin(i * 12.9898 + barCount * 0.3));
    const seed2 = Math.abs(Math.sin(i * 78.233 + barCount * 0.7));
    const rr = r + 80 + seed * (160 + 120 * high + 80 * hihatHit);
    sparks.push(
      <circle
        key={`spk-${i}`}
        cx={cx + Math.cos(a) * rr}
        cy={cy + Math.sin(a) * rr}
        r={1.2 + seed2 * (1.5 + hihatHit * 1.2)}
        fill="#FFFFFF"
        opacity={0.35 + high * 0.4 + hihatHit * 0.5}
      />,
    );
  }

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
      preserveAspectRatio="xMidYMid slice"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
      }}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="orbCore" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="22%" stopColor="#E5BFFF" stopOpacity="0.85" />
          <stop offset="55%" stopColor={KESSEY_PURPLE} stopOpacity="0.55" />
          <stop offset="100%" stopColor={KESSEY_PURPLE} stopOpacity="0" />
        </radialGradient>
        <radialGradient id="orbHaze" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={KESSEY_PURPLE} stopOpacity="0.45" />
          <stop offset="60%" stopColor={KESSEY_PURPLE_DEEP} stopOpacity="0.18" />
          <stop offset="100%" stopColor="#06060A" stopOpacity="0" />
        </radialGradient>
        <filter id="orbBlur" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation={`${22 * GLOW_MULT}`} />
        </filter>
      </defs>

      <circle
        cx={cx}
        cy={cy}
        r={hazeR}
        fill="url(#orbHaze)"
        opacity={0.85 * GLOW_MULT}
        filter="url(#orbBlur)"
      />

      <g opacity={0.85}>{spikes}</g>

      {rings}

      <circle
        cx={cx}
        cy={cy}
        r={r * 0.95}
        fill="url(#orbCore)"
        opacity={0.78 + kickHit * 0.18}
        style={{
          filter: `drop-shadow(0 0 ${(60 + kickHit * 60) * GLOW_MULT}px rgba(157,0,255,${
            0.6 + bass * 0.25 + kickHit * 0.4
          }))`,
        }}
      />

      <circle
        cx={cx}
        cy={cy}
        r={coreR}
        fill="#FFFFFF"
        opacity={0.7 + kickHit * 0.3}
        style={{
          filter: `drop-shadow(0 0 ${(30 + kickHit * 50) * GLOW_MULT}px rgba(232,170,255,${
            0.85 + kickHit * 0.15
          }))`,
        }}
      />

      {sparks}
    </svg>
  );
};

const ProgressBar: React.FC<{
  played: number;
  total: number;
  audio: AudioState;
}> = ({played, total, audio}) => {
  const pct = total > 0 ? played / total : 0;
  const N = 120;
  const filled = Math.floor(N * pct);
  const segs = [];
  for (let i = 0; i < N; i++) {
    const isFilled = i <= filled;
    const headPulse = i === filled ? 1 + audio.bass * 0.6 : 1;
    segs.push(
      <span
        key={i}
        style={{
          display: 'inline-block',
          flex: '1 1 0',
          minWidth: 0,
          borderRadius: 1,
          background: isFilled ? KESSEY_PURPLE : KESSEY_SMOKE_MID,
          opacity: isFilled ? (i === filled ? 1 : 0.85) : 0.55,
          height: i === filled ? 10 * headPulse : 6,
          boxShadow: isFilled
            ? `0 0 ${12 * GLOW_MULT}px rgba(157,0,255,${
                i === filled ? 0.95 : 0.55
              })`
            : 'none',
        }}
      />,
    );
  }
  return (
    <div
      style={{
        flex: 'none',
        width: 416,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        height: 14,
        overflow: 'hidden',
      }}
    >
      {segs}
    </div>
  );
};

const Chrome: React.FC<{
  artist: string;
  title: string;
  catalog: string;
  audio: AudioState;
  played: number;
  total: number;
}> = ({artist, title, catalog, audio, played, total}) => {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 5,
        pointerEvents: 'none',
        color: TEXT_PRIMARY,
      }}
    >
      {/* TOP-LEFT — logo + label */}
      <div
        style={{
          position: 'absolute',
          top: 56,
          left: 80,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 18}}>
          <img
            src={staticFile('logo-white.png')}
            alt="Kessey Records"
            style={{
              height: 38,
              width: 'auto',
              filter: 'drop-shadow(0 0 14px rgba(157,0,255,0.4))',
            }}
          />
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              border: `1px solid ${KESSEY_BORDER}`,
              background: 'rgba(10,10,12,0.55)',
              fontFamily: FONT_BODY,
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: TEXT_SECONDARY,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: KESSEY_PURPLE,
                boxShadow: '0 0 12px rgba(157,0,255,0.85)',
                animation: 'kr-pulse 2s ease-in-out infinite',
                display: 'inline-block',
              }}
            />
            <span style={{fontFamily: FONT_MONO}}>REC · {catalog}</span>
          </div>
        </div>
        <div
          style={{
            color: TEXT_MUTED,
            fontFamily: FONT_BODY,
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
          }}
        >
          {`${catalog} · KESSEY RECORDS`}
        </div>
      </div>

      {/* CENTER-LEFT — artist + title */}
      <div
        style={{
          position: 'absolute',
          left: 80,
          top: '50%',
          transform: 'translateY(-50%)',
          maxWidth: 760,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignSelf: 'flex-start',
            alignItems: 'center',
            gap: 10,
            padding: '7px 14px',
            border: `1px solid ${KESSEY_PURPLE}`,
            color: TEXT_PRIMARY,
            background: 'rgba(157,0,255,0.08)',
            fontFamily: FONT_BODY,
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            boxShadow:
              '0 0 14px rgba(157,0,255,0.55) inset, 0 0 20px rgba(157,0,255,0.35)',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: KESSEY_PURPLE,
              boxShadow: '0 0 12px rgba(157,0,255,0.95)',
              animation: 'kr-pulse 1.6s ease-in-out infinite',
              display: 'inline-block',
            }}
          />
          NOW PLAYING
        </div>
        <h1
          style={{
            fontFamily: FONT_DISPLAY,
            fontWeight: 700,
            fontSize: 72,
            lineHeight: 0.86,
            letterSpacing: '0.005em',
            textTransform: 'uppercase',
            color: '#fff',
            margin: 0,
            textShadow: '0 0 28px rgba(157,0,255,0.45)',
          }}
        >
          {artist}
        </h1>
        <h2
          style={{
            fontFamily: FONT_DISPLAY,
            fontWeight: 700,
            fontSize: 40,
            lineHeight: 1,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            margin: 0,
            color: KESSEY_PURPLE_GLOW,
            textShadow: '0 0 20px rgba(184,51,255,0.6)',
          }}
        >
          {title}
        </h2>
      </div>

      {/* BOTTOM — progress + signature */}
      <div
        style={{
          position: 'absolute',
          left: 80,
          width: 500,
          bottom: 56,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            fontSize: 18,
            letterSpacing: '0.05em',
            color: TEXT_PRIMARY,
          }}
        >
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: '0.04em',
              color: '#fff',
            }}
          >
            {fmt(played)}
          </span>
          <ProgressBar played={played} total={total} audio={audio} />
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: '0.04em',
              color: TEXT_MUTED,
            }}
          >
            {fmtNeg(total - played)}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-start',
            gap: 32,
            alignItems: 'center',
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: TEXT_MUTED,
          }}
        >
          <div>
            <span
              style={{
                display: 'inline-block',
                width: 7,
                height: 7,
                borderRadius: 999,
                background: KESSEY_PURPLE,
                marginRight: 8,
                verticalAlign: 'middle',
                boxShadow: '0 0 12px rgba(157,0,255,0.85)',
              }}
            />
            KESSEY RECORDS · BUDAPEST
          </div>
        </div>
      </div>
    </div>
  );
};
