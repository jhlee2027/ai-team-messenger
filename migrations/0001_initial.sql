
PRAGMA foreign_keys = ON;
CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE agents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE room_agents (room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, role TEXT NOT NULL, active INTEGER DEFAULT 1, PRIMARY KEY(room_id,agent_id));
CREATE TABLE messages (id TEXT PRIMARY KEY, room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, run_id TEXT, agent_id TEXT, author TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, provider TEXT, model TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE conversation_runs (id TEXT PRIMARY KEY, room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', goal TEXT NOT NULL, concurrency INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX one_active_run ON conversation_runs(room_id) WHERE status IN ('pending','running');
CREATE TABLE run_tasks (id TEXT PRIMARY KEY, run_id TEXT REFERENCES conversation_runs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, agent TEXT NOT NULL, summary INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', error TEXT, started_at TEXT, finished_at TEXT, UNIQUE(run_id,ordinal));
CREATE TABLE usage_records (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, run_id TEXT, task_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'reserved', input_tokens INTEGER, output_tokens INTEGER, estimate INTEGER NOT NULL, error TEXT, limits TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX usage_time ON usage_records(created_at,provider);
CREATE TABLE providers (id TEXT PRIMARY KEY, cooldown_until INTEGER DEFAULT 0, status TEXT);
CREATE TABLE models (provider TEXT, id TEXT, data TEXT NOT NULL, checked_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(provider,id));
CREATE TABLE rate_windows (id TEXT PRIMARY KEY, count INTEGER NOT NULL);
-- Each INSERT is atomic. Parallel isolates cannot overspend the app budget.
CREATE TRIGGER enforce_budget BEFORE INSERT ON usage_records BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM usage_records WHERE created_at >= date('now')) >= json_extract(NEW.limits,'$.globalDay') THEN RAISE(ABORT,'DAILY_LIMIT') END;
 SELECT CASE WHEN (SELECT count(*) FROM usage_records WHERE created_at >= date('now','start of month')) >= json_extract(NEW.limits,'$.globalMonth') THEN RAISE(ABORT,'MONTHLY_LIMIT') END;
 SELECT CASE WHEN (SELECT count(*) FROM usage_records WHERE provider=NEW.provider AND created_at >= date('now')) >= json_extract(NEW.limits,'$.providerDay') THEN RAISE(ABORT,'PROVIDER_DAY_LIMIT') END;
 SELECT CASE WHEN (SELECT count(*) FROM usage_records WHERE provider=NEW.provider AND created_at >= date('now','start of month')) >= json_extract(NEW.limits,'$.providerMonth') THEN RAISE(ABORT,'PROVIDER_MONTH_LIMIT') END;
 SELECT CASE WHEN (SELECT count(*) FROM usage_records WHERE room_id=NEW.room_id AND created_at >= date('now')) >= json_extract(NEW.limits,'$.roomDay') THEN RAISE(ABORT,'ROOM_DAY_LIMIT') END;
 SELECT CASE WHEN (SELECT coalesce(sum(estimate),0) FROM usage_records WHERE provider=NEW.provider AND created_at >= date('now')) + NEW.estimate > json_extract(NEW.limits,'$.tokenDay') THEN RAISE(ABORT,'TOKEN_DAY_LIMIT') END;
END;
