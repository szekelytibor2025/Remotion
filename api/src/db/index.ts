import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import {env} from '../lib/env.js';

const dbPath = path.resolve(env.SQLITE_PATH);
fs.mkdirSync(path.dirname(dbPath), {recursive: true});

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
