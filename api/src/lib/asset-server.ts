import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {env} from './env.js';
import {logger} from './logger.js';

const HOST = '127.0.0.1';

let server: http.Server | null = null;
let baseUrl: string | null = null;

const safeResolve = (relativePath: string): string | null => {
  const root = path.resolve(env.WORK_DIR);
  const resolved = path.resolve(root, '.' + relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
};

export const startAssetServer = (): Promise<string> =>
  new Promise((resolve, reject) => {
    if (baseUrl) return resolve(baseUrl);

    server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400).end();
        return;
      }
      const url = new URL(req.url, `http://${HOST}`);
      const filePath = safeResolve(decodeURIComponent(url.pathname));
      if (!filePath) {
        res.writeHead(403).end();
        return;
      }
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
          res.writeHead(404).end();
          return;
        }
        const range = req.headers.range;
        const total = stat.size;
        if (range) {
          const match = /bytes=(\d+)-(\d*)/.exec(range);
          if (match && match[1] !== undefined) {
            const start = Number.parseInt(match[1], 10);
            const end =
              match[2] !== undefined && match[2] !== ''
                ? Number.parseInt(match[2], 10)
                : total - 1;
            if (start >= total || end >= total) {
              res.writeHead(416, {'Content-Range': `bytes */${total}`}).end();
              return;
            }
            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${total}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': end - start + 1,
            });
            fs.createReadStream(filePath, {start, end}).pipe(res);
            return;
          }
        }
        res.writeHead(200, {
          'Content-Length': total,
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(filePath).pipe(res);
      });
    });

    server.on('error', reject);
    server.listen(env.ASSET_SERVER_PORT, HOST, () => {
      baseUrl = `http://${HOST}:${env.ASSET_SERVER_PORT}`;
      logger.info({baseUrl}, 'Asset server listening');
      resolve(baseUrl);
    });
  });

export const assetUrlFor = (absoluteFilePath: string): string => {
  if (!baseUrl) throw new Error('Asset server not started');
  const root = path.resolve(env.WORK_DIR);
  const rel = path.relative(root, absoluteFilePath).split(path.sep).join('/');
  return `${baseUrl}/${rel.split('/').map(encodeURIComponent).join('/')}`;
};
