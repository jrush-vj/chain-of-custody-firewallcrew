# Platform handover: what the bank platform needs to do

**For:** Jaganath (platform repo). **From:** Jeev (defence repo).

**Short version:** you will not write any adapter code. The defence now ships its own collectors, which read the evidence the platform leaves behind. You need to make two small changes (one nginx config line and one SQL migration) and answer two questions. Nothing in the app's JavaScript changes.

The contract is `defense/docs/CONTRACT.md` on `main` of <THIS_REPOSITORY_URL>. The main changes are in section 7 ("Config keys").

---

## 1. Approve the contract (v0.2 + v0.3 together)
- **v0.2:** event types are open (any snake_case name), there are no floats anywhere in `details` (money is a string), and the config has a `[profile]` section.
- **v0.3:** the defence reads your platform through collectors configured in a profile:
  - `db_audit`: reads a PostgreSQL audit table.
  - `access_log`: reads the nginx access log, and can turn `POST /api/auth/login` + 200/401 into `login_success` / `login_failed`.
  - Also two wording fixes in sections 5 and 6, which don't affect you.

Reply "OK v0.2 + v0.3", or say what you would change. After the merge, update your pinned copy of `CONTRACT.md`.

## 2. Two questions
1. Which nginx handles the `/api/...` requests: the frontend nginx (`frontend/nginx/default.conf`) or Nginx Proxy Manager? The access log has to come from the one that sees API calls.
2. Does logging in write anything to the database (a sessions table, a `last_login` column, a login history table)? If it does, the DB audit can record **who** logged in. The access log can't, because it only sees the URL and the status code.

## 3. Change A: write the nginx access log to a file (config only)
Right now the official nginx image sends the access log to stdout (`docker logs`), and the defence can't keep that safely. Add a second log that goes to a file in a shared volume. Use the nginx from question 1; this example is for the frontend nginx.

In `frontend/nginx/default.conf`, inside the `server { ... }` block:
```nginx
access_log /var/log/nginx/coc/access.log combined;
```
Use the folder `coc/`, not `/var/log/nginx/access.log`: in the official image that path is a link to stdout. The existing stdout log keeps working, because nginx allows several `access_log` lines.

In `docker-compose.yml`, give the frontend service a named volume for that folder:
```yaml
services:
  frontend:            # your existing service, add only the volume line
    volumes:
      - coc_logs:/var/log/nginx/coc
volumes:
  coc_logs:
```
The defence mounts the same volume **read-only**.

**Check:** load a page, then `docker exec banking-frontend tail -n 3 /var/log/nginx/coc/access.log` shows lines like `172.18.0.1 - - [12/Oct/2026:09:15:30 +0000] "GET /api/... HTTP/1.1" 200 ...`.

## 4. Change B: audit table + read-only user (one SQL migration)
This records every insert, update and delete on the important tables. Add it as a migration (or an init script) in the platform repo. Change the table names in the last part to match your schema.

```sql
-- 1. The audit table (append-only by convention; the defence only reads it)
CREATE TABLE IF NOT EXISTS coc_audit (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT NOT NULL DEFAULT 'unknown',
  event_type  TEXT NOT NULL,
  table_name  TEXT NOT NULL,
  row_id      TEXT,
  old_row     JSONB,
  new_row     JSONB
);

-- 2. One trigger function for every audited table.
--    TG_ARGV[0] is the event prefix: 'transaction' -> transaction_created / _updated / _deleted
--    TG_ARGV[1..] are columns to leave out (passwords, tokens).
CREATE OR REPLACE FUNCTION coc_audit_fn() RETURNS trigger AS $$
DECLARE
  old_j JSONB := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  new_j JSONB := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  i INT;
BEGIN
  FOR i IN 1 .. TG_NARGS - 1 LOOP
    old_j := old_j - TG_ARGV[i];
    new_j := new_j - TG_ARGV[i];
  END LOOP;
  INSERT INTO coc_audit (actor, event_type, table_name, row_id, old_row, new_row)
  VALUES (
    COALESCE(NULLIF(current_setting('app.user', true), ''), 'unknown'),
    TG_ARGV[0] || CASE TG_OP WHEN 'INSERT' THEN '_created' WHEN 'UPDATE' THEN '_updated' ELSE '_deleted' END,
    TG_TABLE_NAME,
    COALESCE(new_j ->> 'id', old_j ->> 'id'),
    old_j,
    new_j
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 3. Attach it to your tables (rename to match your schema)
CREATE OR REPLACE TRIGGER coc_audit_transactions AFTER INSERT OR UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION coc_audit_fn('transaction');
CREATE OR REPLACE TRIGGER coc_audit_accounts AFTER INSERT OR UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION coc_audit_fn('account');
CREATE OR REPLACE TRIGGER coc_audit_users AFTER INSERT OR UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION coc_audit_fn('user', 'password', 'password_hash');

-- 4. A user that can only read the audit table (pick your own password)
CREATE ROLE coc_reader LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE bankingsystem TO coc_reader;
GRANT USAGE ON SCHEMA public TO coc_reader;
GRANT SELECT ON coc_audit TO coc_reader;
```

Notes:
- **Password columns:** list every secret column after the prefix (as for `users` above) so it never reaches the logs. Use your real column names.
- **Actor:** this works without it (`unknown`). If you want the user's name in the audit, the backend can run `SET LOCAL app.user = '<username>'` inside each transaction. That's optional and a code change, so only if you want it.
- **Money:** keep amounts as `NUMERIC`, not `REAL`/`DOUBLE`. The defence turns them into exact strings.
- **Reaching the database:** the defence connects as `coc_reader`, either on the compose network (host `banking-postgres`) or through port 5432. Send the connection string to Jeev privately; never commit it.

**Check:** create a transaction in the app, then:
```
docker exec banking-postgres psql -U postgres -d bankingsystem -c "SELECT id, ts, event_type, table_name FROM coc_audit ORDER BY id DESC LIMIT 3;"
```
shows a `transaction_created` row.

## 5. Not needed
- No changes to the app's JavaScript, morgan or console logging.
- No adapter scripts, no spool file. The defence's collectors handle that.
- Nothing from the defence repo goes into the platform repo except your pinned copy of `CONTRACT.md`.

## 6. Reply to Jeev with
- [ ] "OK v0.2 + v0.3" (or the changes you want)
- [ ] Answer to question 1 (which nginx sees `/api`)
- [ ] Answer to question 2 (does login write to the DB, and to which table)
- [ ] Change A done: the check output from section 3
- [ ] Change B done: the check output from section 4, plus the real table names you attached triggers to
- [ ] The `coc_reader` connection string, sent privately
