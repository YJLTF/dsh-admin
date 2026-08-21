/**
 * 预处理语句缓存。better-sqlite3 不会缓存 `db.prepare`，因此每次调用
 * 重新 prepare 同一条 SQL 都会重新解析它。这里按连接（WeakMap）对
 * 预处理语句做记忆化，对认证等热路径很重要。
 * @module dsh-admin/db/prepared
 */

import type Database from 'better-sqlite3'
import type { Database as Db } from './connection.js'

type Statement = Database.Statement<unknown[], unknown>

const caches = new WeakMap<Db, Map<string, Statement>>()

/** 为连接 prepare（并缓存）一条语句。 */
export function prepare(db: Db, sql: string): Statement {
  let cache = caches.get(db)
  if (cache === undefined) {
    cache = new Map()
    caches.set(db, cache)
  }
  let statement = cache.get(sql)
  if (statement === undefined) {
    statement = db.prepare(sql)
    cache.set(sql, statement)
  }
  return statement
}
