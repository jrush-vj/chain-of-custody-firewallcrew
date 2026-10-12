import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Client } = pg;
const spoolPath = path.resolve(process.env.COC_SPOOL_PATH || '../spool/events.jsonl');
const statePath = path.resolve(process.env.COC_AUDIT_STATE_PATH || '../spool/.audit-offset');
const pollMs = Number.parseInt(process.env.COC_POLL_MS || '500', 10);

const readOffset = () => {
  try {
    return BigInt(fs.readFileSync(statePath, 'utf8').trim() || '0');
  } catch (error) {
    if (error.code === 'ENOENT') return 0n;
    throw error;
  }
};

const writeLine = (event) => {
  fs.mkdirSync(path.dirname(spoolPath), { recursive: true });
  fs.appendFileSync(spoolPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
};

const toEvent = (row) => ({
  source: 'db',
  ts: new Date(row.ts).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  actor: row.actor || 'unknown',
  event_type: row.event_type,
  details: {
    audit_id: row.id.toString(),
    table: row.table_name,
    row_id: row.row_id,
    old: row.old_row,
    new: row.new_row
  }
});

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: Number.parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'bankingsystem',
  user: process.env.COC_DB_USER || process.env.DB_USER || 'postgres',
  password: process.env.COC_DB_PASSWORD || process.env.DB_PASSWORD || 'postgres',
  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : undefined
});

const run = async () => {
  await client.connect();
  let offset = readOffset();
  console.log(`Chain of Custody spooler watching ${spoolPath} from audit id ${offset}`);

  while (true) {
    const result = await client.query(
      `SELECT id, ts, actor, event_type, table_name, row_id, old_row, new_row
       FROM coc_audit WHERE id > $1 ORDER BY id ASC LIMIT 100`,
      [offset.toString()]
    );

    for (const row of result.rows) {
      writeLine(toEvent(row));
      offset = BigInt(row.id);
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, `${offset}\n`, 'utf8');
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};

run().catch((error) => {
  console.error('Chain of Custody spooler stopped:', error);
  process.exitCode = 1;
});
