/**
 * 数据库结构迁移。
 * @module dsh-admin/db/schema
 */

import type { Database } from './connection.js'

const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  pass_hash    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'pending'
               CHECK (role IN ('admin','pending','active','disabled')),
  home_dir     TEXT NOT NULL,
  api_key_ref  TEXT,
  created_at   INTEGER NOT NULL,
  approved_by  TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (user_id, rel_path)
);

CREATE TABLE IF NOT EXISTS folder_plugins (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plugin_id    TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  description  TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS dsh_instances (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id),
  role         TEXT NOT NULL CHECK (role IN ('main','watchdog')),
  pid          INTEGER,
  port         INTEGER,
  status       TEXT NOT NULL
               CHECK (status IN ('starting','running','crashed','repairing','stopped')),
  started_at   INTEGER,
  last_exit    INTEGER,
  exit_code    INTEGER,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  actor        TEXT,
  action       TEXT NOT NULL,
  detail       TEXT
);

CREATE TABLE IF NOT EXISTS credential_vault (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  key_name   TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, key_name)
);
`

/** v2：每用户命名凭据键，附带启用标志。 */
const V2_SCHEMA = `
ALTER TABLE credential_vault ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;
`

/** v3：管理员维护的共享 DSH 配置 + 每用户接受状态。 */
const V3_SCHEMA = `
CREATE TABLE IF NOT EXISTS shared_config (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  payload     TEXT NOT NULL,
  version     INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shared_config_state (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  accepted_version INTEGER NOT NULL,
  applied_payload  TEXT NOT NULL,
  accepted_at      INTEGER NOT NULL
);
`

/** v4：每用户凭据库被管理员维护的共享配置取代
 * （凭据合并进每个用户的 `.credentials.yaml`）。 */
const V4_SCHEMA = `
DROP TABLE IF EXISTS credential_vault;
`

/** v5：删除自定义域名表（域名/nginx 部署方案已移除；
 * Docker + 内网发布是唯一支持的部署方式）。 */
const V5_SCHEMA = `
DROP TABLE IF EXISTS domains;
`

/** v6：删除已移除功能的残留 —— 从未使用的 `dsh_instances`
 * 镜像表（进程管理器状态刻意保存在内存中）以及已删除的
 * 凭据库遗留下的 `users.api_key_ref` 列。 */
const V6_SCHEMA = `
DROP TABLE IF EXISTS dsh_instances;
ALTER TABLE users DROP COLUMN api_key_ref;
`

/** v7：账号/会话管理与离线插件市场 —— 会话最后活跃时间（设备列表
 * 展示与吊销判断）、运行时应用设置（注册开关/邀请码，管理台可改、
 * 立即生效）、市场条目与每用户安装记录；顺带删除从未写入过的
 * `folder_plugins.description` 死列。 */
const V7_SCHEMA = `
ALTER TABLE sessions ADD COLUMN last_used_at INTEGER;

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS market_items (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('cordis-plugin','skill','agent-preset')),
  name        TEXT NOT NULL,
  version     TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  dir         TEXT NOT NULL,
  warnings    TEXT NOT NULL DEFAULT '[]',
  imported_at INTEGER NOT NULL,
  UNIQUE (kind, name, version)
);

CREATE TABLE IF NOT EXISTS user_plugins (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  market_item_id TEXT NOT NULL REFERENCES market_items(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  version        TEXT NOT NULL,
  installed_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

ALTER TABLE folder_plugins DROP COLUMN description;
`

/** v8：清理 users 上只写不读的死列 —— `home_dir`（每用户路径一律由
 * dataRoot + id 确定性派生，见 fs/workspace.ts，库里的值从未被读取）
 * 与 `approved_by`（审核人只写入、无任何展示或判定消费）。 */
const V8_SCHEMA = `
ALTER TABLE users DROP COLUMN home_dir;
ALTER TABLE users DROP COLUMN approved_by;
`

/** v9：市场条目的导入期增强元数据 —— `--dump-config` 沙箱校验结论、
 * 披露声明（STANDARD §9 最小子集）、offline-packager 元数据/自包含
 * 标记。均为 JSON 文本，空串 = 未采集（旧条目无需回填）。 */
const V9_SCHEMA = `
ALTER TABLE market_items ADD COLUMN validation TEXT NOT NULL DEFAULT '';
ALTER TABLE market_items ADD COLUMN disclosure TEXT NOT NULL DEFAULT '';
ALTER TABLE market_items ADD COLUMN pack_meta TEXT NOT NULL DEFAULT '';
`

/** v10：管理员共享推送 —— 市场条目可标记「推送全员」（仅技能/预设，
 * launch 时自动装进每个用户 home）；user_plugins 记录安装来源
 * （shared = 管理员推送，用户不可自行卸载），取消推送时降级回 user。 */
const V10_SCHEMA = `
ALTER TABLE market_items ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_plugins ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
`

/** v11：定时 agent 任务 —— 每用户的一次性 headless DSH 任务调度
 * （interval / daily 两种排程）与运行历史（输出尾部留在 detail，
 * 不写用户工作区）。运行状态只落这两张表；进程管理仍在内存。 */
const V11_SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  schedule_kind    TEXT NOT NULL CHECK (schedule_kind IN ('interval','daily')),
  interval_minutes INTEGER,
  daily_time       TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  last_run_at      INTEGER,
  last_status      TEXT,
  next_run_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_next ON scheduled_tasks(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  trigger_kind TEXT NOT NULL DEFAULT 'scheduled',
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL DEFAULT 'running',
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_task ON scheduled_task_runs(task_id, started_at);
`

/** v12：入站 webhook —— 把内网事件（CI 完成审批、表单提交等）转换成
 * 一次性 headless DSH 任务的触发器。每个 hook 随机 128-bit token，
 * 命中即以归属用户的身份跑 prompt；日志（任务历史）复用
 * scheduled_task_runs（task_id 为空语义不可行，改为独立列冗余 name）。 */
const V12_SCHEMA = `
CREATE TABLE IF NOT EXISTS inbound_webhooks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_fired_at INTEGER
);

CREATE TABLE IF NOT EXISTS webhook_fire_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL REFERENCES inbound_webhooks(id) ON DELETE CASCADE,
  fired_at   INTEGER NOT NULL,
  status     TEXT NOT NULL,
  detail     TEXT
);
`

/** v13：补查询索引 —— webhook 触发日志按（hook, 时间）倒序翻页、
 * 任务与 webhook 的按用户列表/计数此前都只能全表扫描
 * （SQLite 外键不会自动建索引，v11 给 runs 建过、v12 漏了这条）。 */
const V13_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_webhook_fires ON webhook_fire_log(webhook_id, fired_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON scheduled_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_user ON inbound_webhooks(user_id);
`

interface Migration {
  version: number
  name: string
  sql: string
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '初始结构', sql: V1_SCHEMA },
  { version: 2, name: '凭据库启用标志', sql: V2_SCHEMA },
  { version: 3, name: '共享配置', sql: V3_SCHEMA },
  { version: 4, name: '删除凭据库', sql: V4_SCHEMA },
  { version: 5, name: '删除域名表', sql: V5_SCHEMA },
  { version: 6, name: '删除 dsh_instances 与 api_key_ref', sql: V6_SCHEMA },
  { version: 7, name: '会话活跃/应用设置/插件市场', sql: V7_SCHEMA },
  { version: 8, name: '清理 users 死列', sql: V8_SCHEMA },
  { version: 9, name: '市场条目校验/披露/打包元数据', sql: V9_SCHEMA },
  { version: 10, name: '市场条目共享推送与安装来源', sql: V10_SCHEMA },
  { version: 11, name: '定时 agent 任务与运行历史', sql: V11_SCHEMA },
  { version: 12, name: '入站 webhook 与触发日志', sql: V12_SCHEMA },
  { version: 13, name: '任务/webhook 用户索引与触发日志索引', sql: V13_SCHEMA },
]

/** 在单个事务内应用所有尚未应用的迁移。 */
export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
  const applied = new Set(rows.map((row) => row.version))

  const apply = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now(),
      )
    }
  })
  apply()
}
