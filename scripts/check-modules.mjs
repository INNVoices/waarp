// Find source modules unreachable from the three production entry points.
// TypeScript's own resolver follows static imports, re-exports and literal import().
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const loaded = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile)
if (loaded.error) throw new Error('Could not read tsconfig.json')
const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root)
if (parsed.errors.length) throw new Error('Could not resolve tsconfig.json')
const graph = new Map()
// TypeScript emits forward slashes on Windows; normalize before comparing with
// platform paths, otherwise the check silently accepts an empty source graph.
for (const file of parsed.fileNames.map(file => resolve(file)).filter(file => file.startsWith(join(root, 'src') + sep) && !file.endsWith('.d.ts'))) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const dependencies = []
  function visit(node) {
    let target
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) target = node.moduleSpecifier.text
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) target = node.arguments[0].text
    if (target) {
      const found = ts.resolveModuleName(target, file, parsed.options, ts.sys).resolvedModule
      if (found) dependencies.push(resolve(found.resolvedFileName))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  graph.set(resolve(file), dependencies)
}
const reached = new Set()
const queue = ['src/main/index.ts', 'src/preload/index.ts', 'src/renderer/src/main.tsx'].map(file => join(root, file))
for (const entry of queue) if (!graph.has(entry)) throw new Error(`Production entry is missing from the module graph: ${relative(root, entry)}`)
while (queue.length) {
  const file = queue.pop()
  if (reached.has(file)) continue
  reached.add(file)
  queue.push(...(graph.get(file) ?? []))
}
const unused = [...graph.keys()].filter(file => !reached.has(file)).map(file => relative(root, file))
if (unused.length) {
  console.error('Unreachable production modules:\n' + unused.join('\n'))
  process.exitCode = 1
} else console.log(`modules ok: ${graph.size} production modules reachable; declarations are checked by typecheck`)
