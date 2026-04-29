import express from 'express';
import {pinoHttp} from 'pino-http';
import {env} from './lib/env.js';
import {logger} from './lib/logger.js';
import {runMigrations} from './db/migrate.js';
import renderRoutes from './routes/render.js';
import healthRoutes from './routes/health.js';

runMigrations();

const app = express();

app.set('trust proxy', 1);
app.use(express.json({limit: '64kb'}));
app.use(pinoHttp({logger}));

app.use('/api/v1', renderRoutes);
app.use('/', healthRoutes);

app.use((_req, res) => {
  res.status(404).json({error: 'not_found', message: 'Route not found'});
});

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    logger.error({err: err.message, stack: err.stack}, 'Unhandled error');
    res.status(500).json({error: 'internal_error', message: 'Internal server error'});
  },
);

const server = app.listen(env.PORT, env.HOST, () => {
  logger.info({port: env.PORT, host: env.HOST}, 'API server listening');
});

const shutdown = () => {
  logger.info('Server shutting down');
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
