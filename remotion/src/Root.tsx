import React from 'react';
import {CalculateMetadataFunction, Composition, staticFile} from 'remotion';
import {getAudioDurationInSeconds} from '@remotion/media-utils';
import {Rings, RingsProps} from './Rings';

const FPS = 60;
const WIDTH = 3840;
const HEIGHT = 2160;

const resolveAudioUrl = (audioUrl: string): string => {
  if (/^(https?:|file:|data:)/.test(audioUrl)) return audioUrl;
  return staticFile(audioUrl);
};

const calculateMetadata: CalculateMetadataFunction<RingsProps> = async ({
  props,
}) => {
  const resolvedAudioUrl = resolveAudioUrl(props.audioUrl);
  const durationSeconds = await getAudioDurationInSeconds(resolvedAudioUrl);
  return {
    durationInFrames: Math.max(1, Math.round(durationSeconds * FPS)),
    props: {...props, audioUrl: resolvedAudioUrl},
  };
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Rings"
      component={Rings}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      durationInFrames={1800}
      defaultProps={{
        artist: 'R.DAWE & DANK.L',
        title: 'Fortune Dream',
        catalog: 'KSY—026',
        year: '2026',
        audioUrl: staticFile('demo.wav'),
        paletteKey: 'violet' as const,
      }}
      calculateMetadata={calculateMetadata}
    />
  );
};
