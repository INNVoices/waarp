// Build-time contract for the two UI dictionaries. This does not grade translation
// quality or claim to resolve computed message IDs. Runtime fallbacks stay intact.
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse, parseExpression } from '@babel/parser'

const categories = new Set(['zero', 'one', 'two', 'few', 'many', 'other'])
const androidRoot = 'android/app/src/main'
const kotlinRoot = `${androidRoot}/java/local/waarp/android`
const normalized = value => JSON.stringify([...value].sort())
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
const literal = node => node?.type === 'StringLiteral' ? node.value :
  node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : undefined

function visit(node, fn) {
  if (!node || typeof node.type !== 'string') return
  fn(node)
  for (const [key, child] of Object.entries(node)) {
    if (/^(?:loc|extra|.*Comments)$/.test(key)) continue
    if (Array.isArray(child)) child.forEach(value => visit(value, fn))
    else if (child && typeof child === 'object') visit(child, fn)
  }
}

function files(root, directory, extension) {
  const result = []
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) result.push(...files(root, path, extension))
    else if (extension.test(entry.name)) result.push(path)
  }
  return result.sort()
}

function stringChoices(node) {
  const value = literal(node)
  if (value !== undefined) return [value]
  if (node?.type === 'ConditionalExpression') {
    const left = stringChoices(node.consequent), right = stringChoices(node.alternate)
    return left && right ? [...new Set([...left, ...right])] : undefined
  }
  if (node?.type === 'TSAsExpression' || node?.type === 'TSNonNullExpression') return stringChoices(node.expression)
  return undefined
}

// The lexer recognizes Kotlin comments (including nested block comments), ordinary
// strings, raw strings and characters. Literal code examples are never call sites.
// It is deliberately not a Kotlin compiler; nonliteral ID/fallback calls refuse.
export function kotlinTokens(source) {
  const result = []
  let at = 0, line = 1
  const advance = end => { line += (source.slice(at, end).match(/\n/g) ?? []).length; at = end }
  while (at < source.length) {
    if (/\s/.test(source[at])) { advance(at + 1); continue }
    if (source.startsWith('//', at)) { const end = source.indexOf('\n', at); advance(end < 0 ? source.length : end); continue }
    if (source.startsWith('/*', at)) {
      let depth = 1, end = at + 2
      while (end < source.length && depth) {
        if (source.startsWith('/*', end)) { depth++; end += 2 }
        else if (source.startsWith('*/', end)) { depth--; end += 2 }
        else end++
      }
      if (depth) throw new Error(`unterminated Kotlin comment at line ${line}`)
      advance(end); continue
    }
    const start = at, startLine = line
    if (source.startsWith('"""', at)) {
      const end = source.indexOf('"""', at + 3)
      if (end < 0) throw new Error(`unterminated Kotlin raw string at line ${line}`)
      const value = source.slice(at + 3, end)
      result.push({ kind: 'string', value, line, dynamic: /\$(?:\{|[A-Za-z_])/.test(value) })
      advance(end + 3); continue
    }
    if (source[at] === '"' || source[at] === "'") {
      const quote = source[at]
      let end = at + 1, value = '', dynamic = false
      for (; end < source.length && source[end] !== quote; end++) {
        if (source[end] === '\\') {
          const escaped = source[++end]
          if (escaped === 'u') {
            const digits = source.slice(end + 1, end + 5)
            if (!/^[a-f\d]{4}$/i.test(digits)) throw new Error(`invalid Kotlin unicode escape at line ${line}`)
            value += String.fromCharCode(parseInt(digits, 16)); end += 4
          } else value += ({ n: '\n', r: '\r', t: '\t', b: '\b' })[escaped] ?? escaped
        } else {
          if (source[end] === '$' && /[A-Za-z_{]/.test(source[end + 1] ?? '')) dynamic = true
          value += source[end]
        }
      }
      if (end === source.length) throw new Error(`unterminated Kotlin literal at line ${line}`)
      result.push({ kind: quote === '"' ? 'string' : 'char', value, line: startLine, dynamic })
      advance(end + 1); continue
    }
    const identifier = source.slice(at).match(/^[A-Za-z_][\w]*/)?.[0]
    if (identifier) { result.push({ kind: 'id', value: identifier, line }); advance(at + identifier.length) }
    else { result.push({ kind: 'symbol', value: source[start], line }); advance(at + 1) }
  }
  return result
}

function kotlinArguments(tokens, open) {
  const args = [], stack = []
  let start = open + 1
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.kind !== 'symbol') continue
    if (['(', '[', '{'].includes(token.value)) stack.push(token.value)
    else if ([')', ']', '}'].includes(token.value)) {
      if (!stack.length && token.value === ')') {
        if (i > start) args.push(tokens.slice(start, i))
        return args
      }
      stack.pop()
    } else if (token.value === ',' && !stack.length) { args.push(tokens.slice(start, i)); start = i + 1 }
  }
  throw new Error('unterminated Kotlin call')
}

// Match the Java Formatter contract, preserving conversion, flags, width and
// precision while permitting legal explicit-argument reordering in translations.
function printf(text) {
  const result = []
  let next = 1, previous = 0
  const pattern = /%(?:(\d+)\$)?([-#+ 0,(<]*)(\d+)?(?:\.(\d+))?([tT])?([a-zA-Z%])/y
  for (let at = text.indexOf('%'); at >= 0; at = text.indexOf('%', at)) {
    pattern.lastIndex = at
    const match = pattern.exec(text)
    if (!match) { result.push('!invalid'); at++; continue }
    at = pattern.lastIndex
    const [, index, flags, width = '', precision = '', date = '', conversion] = match
    if ((!date && !'bBhHsScCdoxXeEfgGaAn%'.includes(conversion)) || (date && !'HIklMSLNpzZsQBbhAaCYyjmdeRTrDFc'.includes(conversion))) { result.push('!invalid'); continue }
    const consumes = conversion !== '%' && conversion !== 'n'
    const arg = consumes ? (flags.includes('<') ? previous : index ? Number(index) : next++) : 0
    if (consumes) previous = arg
    result.push(`${arg}:${flags.replace('<', '').split('').sort().join('')}:${width}:${precision}:${date}${conversion}`)
  }
  return result.sort()
}

export function checkLocalization(root) {
  const errors = [], stats = { windowsKeys: 0, androidKeys: 0, locales: 0, windowsLiteralCalls: 0, windowsComputedCalls: 0, androidLiteralCalls: 0 }
  const fail = (path, code, detail) => errors.push({ path, code, detail })
  const read = path => readFileSync(join(root, path), 'utf8')
  const attempt = (path, fn, fallback) => {
    try { return fn() } catch (error) { fail(path, 'parse', error.message); return fallback }
  }
  const ast = path => attempt(path, () => parse(read(path), { sourceType: 'module', plugins: ['typescript', 'jsx'] }), null)
  const table = path => attempt(path, () => {
    const source = read(path), value = JSON.parse(source)
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('expected an object of message IDs and strings')
    const seen = new Set()
    for (const property of parseExpression(source).properties) {
      const key = property.key.value
      if (seen.has(key)) fail(path, 'duplicate-id', key)
      seen.add(key)
    }
    for (const [id, message] of Object.entries(value)) {
      if (typeof message !== 'string') { fail(path, 'message-type', `${id}: expected string`); delete value[id] }
    }
    return value
  }, {})
  const sameSet = (path, expected, actual) => {
    if (new Set(actual).size !== actual.length) fail(path, 'duplicate-locale', 'locale registry contains duplicates')
    const missing = expected.filter(value => !actual.includes(value)), extra = actual.filter(value => !expected.includes(value))
    if (missing.length || extra.length) fail(path, 'locale-set', `missing [${missing.join(', ')}]; unexpected [${extra.join(', ')}]`)
  }
  const compare = (path, id, reference, translation, androidFormat = false) => {
    if (normalized(placeholders(reference)) !== normalized(placeholders(translation))) fail(path, 'placeholders', `${id}: expected ${normalized(placeholders(reference))}, got ${normalized(placeholders(translation))}`)
    // Only actual Android format() consumers use printf. A literal percentage
    // followed by prose ("% of checks") is not a formatter invocation.
    if (androidFormat && (printf(reference).includes('!invalid') || printf(translation).includes('!invalid') || normalized(printf(reference)) !== normalized(printf(translation)))) fail(path, 'printf', `${id}: formatter argument/format mismatch`)
  }
  const requireArgs = (path, id, template, count) => {
    for (const key of placeholders(template).filter(key => /^arg\d+$/.test(key))) {
      const index = Number(key.slice(3))
      if (index < 1 || index > count) fail(path, 'argument-count', `${id}: {${key}} has only ${count} supplied values`)
    }
  }

  try {
    const winRuntime = 'src/shared/localization.ts', winAst = ast(winRuntime)
    const locales = [], loaderObjects = []
    visit(winAst, node => {
      if (node.type === 'VariableDeclarator' && node.id.name === 'loaders') loaderObjects.push(node.init)
    })
    if (loaderObjects.length !== 1 || loaderObjects[0]?.type !== 'ObjectExpression') fail(winRuntime, 'registry', 'expected one literal loaders registry')
    else for (const property of loaderObjects[0].properties) {
      const locale = literal(property.key) ?? (property.key?.type === 'Identifier' ? property.key.name : undefined)
      if (!locale || property.computed) { fail(winRuntime, 'registry', 'nonliteral locale loader'); continue }
      locales.push(locale)
      const imports = []
      visit(property.value, node => {
        if (node.type === 'CallExpression' && node.callee.type === 'Import') imports.push(literal(node.arguments[0]))
        if (node.type === 'ImportExpression') imports.push(literal(node.source))
      })
      if (imports.length !== 1 || imports[0] !== `./strings/locales/${locale}.json`) fail(winRuntime, 'loader-path', `${locale}: expected matching locale JSON import`)
    }
    if (!locales.length) fail(winRuntime, 'registry', 'empty locale registry')
    sameSet(winRuntime, locales, locales)
    const codes = ['ru', ...locales]
    stats.locales = codes.length
    const winDirectory = 'src/shared/strings/locales', androidDirectory = `${androidRoot}/assets/locales`
    sameSet(winDirectory, locales.map(locale => `${locale}.json`), readdirSync(join(root, winDirectory)).filter(name => name.endsWith('.json')))
    sameSet(androidDirectory, locales.map(locale => `${locale}.json`), readdirSync(join(root, androidDirectory)).filter(name => name.endsWith('.json')))

    const basePath = 'src/shared/strings/ru.json', base = table(basePath)
    stats.windowsKeys = Object.keys(base).length
    const pluralGroups = new Set(Object.keys(base).filter(key => key.endsWith('.one') && placeholders(base[key]).includes('n')).map(key => key.slice(0, -4)))
    const checkPlural = (path, locale, values) => {
      for (const group of pluralGroups) for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
        // Existing RU runtime intentionally falls back from .other to .many.
        const actual = locale === 'ru' && category === 'other' ? 'many' : category
        if (!Object.hasOwn(values, `${group}.${actual}`)) fail(path, 'plural-category', `${group}: missing ${actual} for ${locale}`)
      }
    }
    checkPlural(basePath, 'ru', base)
    for (const locale of locales) {
      const path = `${winDirectory}/${locale}.json`, values = table(path)
      for (const [id, reference] of Object.entries(base)) {
        if (!Object.hasOwn(values, id)) fail(path, 'missing-id', id)
        else compare(path, id, reference, values[id])
      }
      for (const id of Object.keys(values).filter(id => !Object.hasOwn(base, id))) {
        const dot = id.lastIndexOf('.'), group = id.slice(0, dot), category = id.slice(dot + 1)
        if (!pluralGroups.has(group) || !categories.has(category)) fail(path, 'unknown-id', `${id} is absent from ru.json`)
        else compare(path, id, base[`${group}.one`], values[id])
      }
      checkPlural(path, locale, values)
    }

    for (const path of files(root, 'src', /\.(?:ts|tsx)$/)) {
      const source = ast(path), bindings = new Map()
      for (const node of source?.program.body ?? []) if (node.type === 'ImportDeclaration' && /(?:^|\/)(?:localization|i18n)$/.test(node.source.value)) {
        for (const specifier of node.specifiers) if (specifier.type === 'ImportSpecifier') {
          const name = specifier.imported.name ?? specifier.imported.value
          if (['s', 'message', 'localized', 'sp', 'plural'].includes(name)) bindings.set(specifier.local.name, name)
        }
      }
      visit(source, node => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || !bindings.has(node.callee.name)) return
        const ids = stringChoices(node.arguments[0]), name = bindings.get(node.callee.name)
        if (!ids) { stats.windowsComputedCalls++; return }
        stats.windowsLiteralCalls++
        for (const id of ids) {
          const place = `${path}:${node.loc.start.line}`
          if (name === 'sp' || name === 'plural') {
            if (!pluralGroups.has(id)) fail(place, 'used-id', `unknown plural group ${id}`)
          } else if (!Object.hasOwn(base, id)) fail(place, 'used-id', `${id} is absent from ru.json`)
          else if (name === 'localized' && !node.arguments.some(arg => arg.type === 'SpreadElement')) requireArgs(place, id, base[id], node.arguments.length - 1)
        }
      })
    }

    const androidRuntime = `${kotlinRoot}/i18n/Localization.kt`
    const runtimeTokens = kotlinTokens(read(androidRuntime)), registry = []
    for (let i = 0; i < runtimeTokens.length; i++) if (runtimeTokens[i].value === 'supported' && runtimeTokens[i + 1]?.value === '=' && runtimeTokens[i + 2]?.value === 'setOf') {
      for (const arg of kotlinArguments(runtimeTokens, i + 3)) {
        if (arg.length !== 1 || arg[0].kind !== 'string' || arg[0].dynamic) fail(androidRuntime, 'registry', 'nonliteral supported locale')
        else registry.push(arg[0].value)
      }
    }
    sameSet(androidRuntime, codes, registry)
    const configPath = `${androidRoot}/res/xml/locales_config.xml`
    const stripXmlComments = text => text.replace(/<!--[\s\S]*?-->/g, '')
    const config = stripXmlComments(read(configPath))
    const declared = [...config.matchAll(/<locale\b[^>]*\bandroid:name\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/g)].map(match => match[1])
    sameSet(configPath, codes, declared)
    const manifestPath = `${androidRoot}/AndroidManifest.xml`, manifest = stripXmlComments(read(manifestPath))
    if (!/<application\b[^>]*\bandroid:localeConfig\s*=\s*["']@xml\/locales_config["']/.test(manifest)) fail(manifestPath, 'manifest', 'application must reference @xml/locales_config')

    const fallbacks = new Map(), formattedIds = new Set()
    for (const path of files(root, kotlinRoot, /\.kt$/)) {
      const tokens = attempt(path, () => kotlinTokens(read(path)), [])
      for (let i = 0; i < tokens.length; i++) if (tokens[i].kind === 'id' && tokens[i].value === 'format' && tokens[i + 1]?.value === '(') {
        // String.format(template, ...) or String.format(locale, template, ...).
        if (tokens[i - 1]?.value === '.' && tokens[i - 2]?.value === 'String') {
          const args = kotlinArguments(tokens, i + 1)
          const arg = args[0]?.[0]?.value === 'localized' || args[0]?.[0]?.kind === 'string' ? args[0] : args[1]
          if (arg?.[0]?.value === 'localized' && arg[1]?.value === '(' && arg[2]?.kind === 'string') formattedIds.add(arg[2].value)
        }
        // localized(id, fallback).format(...), the Kotlin extension variant.
        if (tokens[i - 1]?.value === '.' && tokens[i - 2]?.value === ')') {
          let depth = 1, open = i - 3
          for (; open >= 0; open--) if (tokens[open].kind === 'symbol') {
            if (tokens[open].value === ')') depth++
            if (tokens[open].value === '(' && --depth === 0) break
          }
          if (tokens[open - 1]?.value === 'localized' && tokens[open + 1]?.kind === 'string') formattedIds.add(tokens[open + 1].value)
        }
      }
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].kind !== 'id' || tokens[i].value !== 'localized' || tokens[i + 1]?.value !== '(' || tokens[i - 1]?.value === 'fun') continue
        const args = kotlinArguments(tokens, i + 1), place = `${path}:${tokens[i].line}`
        if (args.length < 2 || args.slice(0, 2).some(arg => arg.length !== 1 || arg[0].kind !== 'string' || arg[0].dynamic)) {
          fail(place, 'nonliteral-call', 'localized requires literal ID and fallback for static verification'); continue
        }
        const id = args[0][0].value, fallback = args[1][0].value
        stats.androidLiteralCalls++
        if (fallbacks.has(id) && fallbacks.get(id) !== fallback) fail(place, 'fallback-conflict', `${id}: conflicting literal fallbacks`)
        fallbacks.set(id, fallback)
        if (!args.slice(2).some(arg => arg[0]?.value === '*')) requireArgs(place, id, fallback, args.length - 2)
      }
    }
    stats.androidKeys = fallbacks.size
    if (!fallbacks.size) fail(kotlinRoot, 'calls', 'no literal Android localized calls found')
    const androidTables = new Map(locales.map(locale => [locale, table(`${androidDirectory}/${locale}.json`)]))
    const androidBase = androidTables.get('en') ?? androidTables.values().next().value ?? {}
    for (const [locale, values] of androidTables) {
      const path = `${androidDirectory}/${locale}.json`
      for (const id of new Set([...Object.keys(androidBase), ...fallbacks.keys()])) {
        if (!Object.hasOwn(values, id)) fail(path, 'missing-id', id)
        else compare(path, id, fallbacks.get(id) ?? androidBase[id], values[id], formattedIds.has(id))
      }
      for (const id of Object.keys(values)) if (!Object.hasOwn(androidBase, id) && !fallbacks.has(id)) fail(path, 'unknown-id', `${id} is absent from the Android reference dictionary`)
    }
  } catch (error) { fail(relative(root, error.path ?? root) || '.', 'read', error.message) }
  return { errors, stats }
}
