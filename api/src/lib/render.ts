import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
import {env} from './env.js';
import {logger} from './logger.js';

let bundleLocation: string | null = null;
let bundlePromise: Promise<string> | null = null;

const buildBundle = async (): Promise<string> => {
  if (bundleLocation) return bundleLocation;
  if (bundlePromise) return bundlePromise;

  const remotionRoot = path.resolve(env.REMOTION_BUNDLE_DIR);
  const entryPoint = path.join(remotionRoot, 'src/index.ts');

  if (!fs.existsSync(entryPoint)) {
    throw new Error(`Remotion entry point not found at ${entryPoint}`);
  }

  logger.info({remotionRoot, entryPoint}, 'Bundling Remotion project');
  const t0 = Date.now();
  bundlePromise = bundle({
    entryPoint,
    webpackOverride: (config) => config,
  });
  bundleLocation = await bundlePromise;
  logger.info(
    {bundleLocation, ms: Date.now() - t0},
    'Remotion bundle ready',
  );
  return bundleLocation;
};

export type RenderInputProps = {
  artist: string;
  title: string;
  catalog: string;
  year: string;
  audioUrl: string;
  paletteKey: 'violet' | 'mono' | 'ultra' | 'coronita';
};

export type RenderOptions = {
  inputProps: RenderInputProps;
  outputLocation: string;
  onProgress?: (progress: number) => void;
};

export type RenderResult = {
  durationSeconds: number;
  renderSeconds: number;
  fileSizeBytes: number;
};

export const renderRingsVideo = async (
  options: RenderOptions,
): Promise<RenderResult> => {
  const serveUrl = await buildBundle();
  const t0 = Date.now();

  const composition = await selectComposition({
    serveUrl,
    id: env.REMOTION_COMPOSITION_ID,
    inputProps: options.inputProps,
  });

  const durationSeconds = composition.durationInFrames / composition.fps;
  logger.info(
    {
      compositionId: composition.id,
      durationSeconds,
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
    },
    'Render starting',
  );

  fs.mkdirSync(path.dirname(options.outputLocation), {recursive: true});

  let lastReported = 0;
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: options.outputLocation,
    inputProps: options.inputProps,
    imageFormat: 'jpeg',
    jpegQuality: 90,
    concurrency: env.REMOTION_CONCURRENCY,
    onProgress: ({progress}) => {
      const pct = Math.round(progress * 100);
      if (pct >= lastReported + 5) {
        lastReported = pct;
        options.onProgress?.(pct);
      }
    },
  });

  const stat = fs.statSync(options.outputLocation);
  const renderSeconds = (Date.now() - t0) / 1000;

  logger.info(
    {
      outputLocation: options.outputLocation,
      durationSeconds,
      renderSeconds,
      fileSizeBytes: stat.size,
      ratio: (renderSeconds / durationSeconds).toFixed(2),
    },
    'Render completed',
  );

  return {
    durationSeconds,
    renderSeconds,
    fileSizeBytes: stat.size,
  };
};

export const warmBundle = (): Promise<string> => buildBundle();
