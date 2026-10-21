// 打包约束：清单与产物要满足 Tavern 的一键安装检查。
//
// Tavern 的 readPluginArchive（tavern-plugin/lib/domain/user-plugin-install.js）会：
//   1. 找最浅的 package.json，读 exports["."] 或 main 当宿主入口，文件必须存在；
//   2. dependencies 非空、压缩包里又没有 node_modules/ 时直接拒绝一键安装。
// 任何一条坏了，插件就只能手动装，而单看 src/ 完全看不出来——所以对着根目录的产物测。
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (relative) => readFile(path.join(root, relative), 'utf8')

const exists = async (relative) => {
  try {
    await stat(path.join(root, relative))
    return true
  } catch {
    return false
  }
}

test('没有运行时 npm 依赖：dependencies 必须为空', async () => {
  const pkg = JSON.parse(await read('package.json'))
  assert.deepEqual(Object.keys(pkg.dependencies || {}), [], 'dependencies 非空会挡住 Tavern 一键安装')
  // React 只在构建/测试时用，产物里的那一份由 Tavern 的加载器提供。
  assert.ok(pkg.devDependencies?.react, 'React 应放在 devDependencies')
})

test('仓库根目录就是插件文件夹：宿主入口与浏览器入口都在', async () => {
  const pkg = JSON.parse(await read('package.json'))
  assert.equal(pkg.name, 'dsh-tavern-worldbook-panel')
  assert.ok(pkg.version, 'version 不能省：插件列表与 Release 标签靠它比较')
  assert.equal(pkg.exports['.'], './index.mjs')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(await exists('index.mjs'), '宿主入口必须随仓库提交')
  assert.ok(await exists('client.js'), '浏览器侧产物必须随仓库提交')
})

test('浏览器侧按 dsh.client 契约声明', async () => {
  const pkg = JSON.parse(await read('package.json'))
  assert.equal(pkg.dsh.client.platform, 'web', '少了它界面不加载')
  assert.ok(pkg.dsh.client.inject.includes('dsh-tavern-plugin'))
})

test('client.js 是 Tavern 加载器要的 classic CJS 外壳', async () => {
  const code = await read('client.js')
  assert.match(code, /^\/\/ dsh-tavern-worldbook-panel/, '缺少产物头注释：client.js 应由 build.mjs 生成')
  assert.match(code, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(code, /id: "dsh-tavern-worldbook-panel"/, 'id 必须与 package.json 的 name 一致')
  // 面板用的 React 走加载器的 require，不能再内联一份。
  assert.equal(code.match(/require\("react"\)/g)?.length, 1, 'React 只能 require 一次')
})
