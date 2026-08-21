/**
 * SQLite 连接生命周期：打开、WAL、外键、迁移。
 * @module dsh-admin/db/connection
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runMigrations } from './schema.js'

/** better-sqlite3 的实例类型。 */
export type Database = Database.Database

/**
 * 打开数据库（按需创建父目录），启用 WAL + 外键，
 * 然后执行迁移。
 * @param path - 数据库文件路径，或 `:memory:`。
 */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db: Database = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}
