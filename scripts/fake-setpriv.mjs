// setuid 包装器（如 `setpriv --reuid`）的替身。记录收到的 uid，然后 exec 其余
// argv（真正的 DSH 命令），让冒烟测试既能验证账号级 uid 已传入，又能真的跑起子进程。
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const uidIdx = process.argv.indexOf('--uid')
const uid = uidIdx >= 0 ? process.argv[uidIdx + 1] : 'unknown'
writeFileSync('setpriv-uid.txt', String(uid))
const rest = process.argv.slice(uidIdx >= 0 ? uidIdx + 2 : 2)
if (rest.length > 0) {
  const child = spawn(rest[0], rest.slice(1), { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 0))
} else {
  process.exit(0)
}
