/** 对所有源码做语法检查，避免 package.json 里堆一长串命令。 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const files = [
  ...readdirSync(join(root, 'lib')).filter(name => name.endsWith('.js')).map(name => join(root, 'lib', name)),
  ...readdirSync(join(root, 'scripts')).filter(name => name.endsWith('.js')).map(name => join(root, 'scripts', name)),
]

let failed = 0
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    failed++
    console.error(`✗ ${file}`)
    console.error(String(error.stderr ?? '').split('\n').slice(0, 4).join('\n'))
  }
}
console.log(failed === 0 ? `✓ ${files.length} 个文件语法通过` : `✗ ${failed}/${files.length} 个文件有语法错误`)
process.exit(failed === 0 ? 0 : 1)
