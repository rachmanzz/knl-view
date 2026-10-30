import { createRequire } from 'node:module'
import { Parser, Language } from 'web-tree-sitter'

// Syntax-aware import extraction with tree-sitter (web-tree-sitter, WASM).
// One uniform parser API for every supported language: adding a language
// means adding one grammar package and one extraction case. Grammars are
// lazy-loaded only when the scanned project actually contains files of
// that language.
//
// Extraction returns the raw import specifiers of a file; deciding which
// of them point inside the project is the resolver's job (sources.js), so
// this module stays language-shaped, not project-shaped.

const require = createRequire(import.meta.url)

const GRAMMAR_WASM = {
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  go: 'tree-sitter-go/tree-sitter-go.wasm'
}

/** The JS family shares one grammar; each other extension has its own. */
export const SYNTAX_LANGUAGES = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.go': 'go'
}

let initPromise = null
const languages = new Map() // grammar name -> Language
const parsers = new Map() // grammar name -> Parser

async function languageFor(ext) {
  const name = SYNTAX_LANGUAGES[ext]
  if (languages.has(name)) return languages.get(name)
  initPromise ||= Parser.init()
  await initPromise
  const lang = await Language.load(require.resolve(GRAMMAR_WASM[name]))
  languages.set(name, lang)
  return lang
}

function parserFor(name, lang) {
  if (!parsers.has(name)) {
    const parser = new Parser()
    parser.setLanguage(lang)
    parsers.set(name, parser)
  }
  return parsers.get(name)
}

function firstDescendant(node, type) {
  if (node.type === type) return node
  for (let i = 0; i < node.childCount; i++) {
    const found = firstDescendant(node.child(i), type)
    if (found) return found
  }
  return null
}

/**
 * Raw specifiers from one parsed tree. JS: ESM import/export sources,
 * dynamic import(), and require(). Go: every import_spec path, alias or
 * not. Bare names, URLs, and package paths are returned as-is; filtering
 * to project-internal targets happens in the resolver.
 */
function specsFromTree(grammar, tree) {
  const specs = []
  const names = []
  const visit = (node) => {
    if (grammar === 'javascript') {
      if (node.type === 'import_statement' || node.type === 'export_statement') {
        const source = node.childForFieldName('source')
        const fragment = source && firstDescendant(source, 'string_fragment')
        if (fragment) specs.push(fragment.text)
        // Local binding names a qualified call may be addressed through:
        // the default import, the namespace alias, and each named import.
        for (let i = 0; i < node.childCount; i++) {
          const clause = node.child(i)
          if (clause.type !== 'import_clause') continue
          for (let j = 0; j < clause.childCount; j++) {
            const part = clause.child(j)
            if (part.type === 'identifier') names.push(part.text)
            else if (part.type === 'namespace_import') {
              for (let k = 0; k < part.childCount; k++) {
                if (part.child(k).type === 'identifier') names.push(part.child(k).text)
              }
            } else if (part.type === 'named_imports') {
              for (let k = 0; k < part.childCount; k++) {
                const specifier = part.child(k)
                if (specifier.type !== 'import_specifier') continue
                const alias = specifier.childForFieldName('alias') || specifier.childForFieldName('name')
                if (alias) names.push(alias.text)
              }
            }
          }
        }
      } else if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function')
        if (fn && (fn.text === 'require' || fn.text === 'import')) {
          const args = node.childForFieldName('arguments')
          const fragment = args && firstDescendant(args, 'string_fragment')
          if (fragment) specs.push(fragment.text)
          // `const x = require('y')` / `const x = await import('y')`: the
          // declarator name is the binding: the visit starts above it, so
          // walk down from any enclosing declarator via field lookup here.
          let parent = node.parent
          while (parent && parent.type === 'await_expression') parent = parent.parent
          if (parent && parent.type === 'variable_declarator') {
            const name = parent.childForFieldName('name')
            if (name) names.push(name.text)
          }
        }
      }
    } else if (grammar === 'go') {
      if (node.type === 'import_spec') {
        const declared = node.childForFieldName('path')
        const fragment = declared && firstDescendant(declared, 'interpreted_string_literal_content')
        if (fragment) {
          const path = fragment.text
          specs.push(path)
          // The name a qualified call uses: the declared alias, or the last
          // path segment (Go's convention when no alias is given).
          const alias = node.childForFieldName('name')
          if (alias) names.push(alias.text)
          else names.push(path.slice(path.lastIndexOf('/') + 1))
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i))
  }
  visit(tree.rootNode)
  return { specs, names }
}

/**
 * Parse one file's text with the grammar of its extension and return its
 * raw import specifiers. A syntax error never throws: tree-sitter recovers
 * and whatever imports are well-formed are still extracted.
 * @param {string} ext lowercase extension with the dot, e.g. '.go'
 * @param {string} content file text
 * @returns {Promise<string[]>}
 */
export async function extractImportSpecifiers(ext, content) {
  return (await extractCode(ext, content)).imports
}

/**
 * Parse one file once and extract everything the sources graph needs:
 *
 *   imports   raw import specifiers (see extractImportSpecifiers)
 *   importNames local names those imports are addressed by: JS bindings
 *             (default/namespace/named, plus `const x = require/import`),
 *             Go aliases or last path segments. Evidence that a receiver
 *             prefix in a qualified call refers to an import.
 *   symbols   named definitions: { name, kind, line, lines }, line 1-based,
 *             lines = height of the definition
 *   calls     call sites: { name, recv, row }, row 0-based; recv is the
 *             receiver/prefix text for qualified calls (recv.method(),
 *             pkg.Fn()) and null for plain identifiers
 *
 * Calls are attributed to nothing here; mapping a call to its enclosing
 * symbol is the caller's job (it needs the full symbol list anyway).
 * A syntax error never throws: tree-sitter recovers and whatever is
 * well-formed is still extracted.
 */
export async function extractCode(ext, content) {
  const lang = await languageFor(ext)
  const grammar = SYNTAX_LANGUAGES[ext]
  const parser = parserFor(grammar, lang)
  const tree = parser.parse(content)
  try {
    const { specs: imports, names: importNames } = specsFromTree(grammar, tree)
    const { symbols, calls } = structureFromTree(grammar, tree)
    return { imports, importNames, symbols, calls }
  } finally {
    tree.delete()
  }
}

/**
 * Named definitions and call sites from one parsed tree. Only definitions
 * that carry an explicit name enter the graph; anonymous helpers are left
 * out, deterministically.
 */
function structureFromTree(grammar, tree) {
  const symbols = []
  const calls = []
  const pushSymbol = (node, name, kind) => {
    symbols.push({
      name,
      kind,
      line: node.startPosition.row + 1,
      lines: node.endPosition.row - node.startPosition.row + 1
    })
  }
  const visit = (node, cls) => {
    if (grammar === 'javascript') {
      if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
        const name = node.childForFieldName('name')
        if (name) pushSymbol(node, name.text, 'function')
      } else if (node.type === 'class_declaration') {
        const name = node.childForFieldName('name')
        if (name) {
          pushSymbol(node, name.text, 'class')
          cls = name.text // class body below walks with this name in scope
        }
      } else if (node.type === 'method_definition') {
        const name = node.childForFieldName('name')
        if (name && name.type === 'property_identifier' && cls) {
          pushSymbol(node, `${cls}.${name.text}`, 'method')
        }
      } else if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        for (let i = 0; i < node.childCount; i++) {
          const declarator = node.child(i)
          if (declarator.type !== 'variable_declarator') continue
          const value = declarator.childForFieldName('value')
          const name = declarator.childForFieldName('name')
          if (value && name && (value.type === 'arrow_function' || value.type === 'function_expression')) {
            pushSymbol(declarator, name.text, 'function')
          }
        }
      }
    } else if (grammar === 'go') {
      if (node.type === 'function_declaration') {
        const name = node.childForFieldName('name')
        if (name) pushSymbol(node, name.text, 'function')
      } else if (node.type === 'method_declaration') {
        const name = node.childForFieldName('name')
        const receiver = node.childForFieldName('receiver')
        const recvType = receiver && firstDescendant(receiver, 'type_identifier')
        if (name && recvType) pushSymbol(node, `${recvType.text}.${name.text}`, 'method')
      } else if (node.type === 'type_spec') {
        const name = node.childForFieldName('name')
        if (name) pushSymbol(node, name.text, 'type')
      }
    }
    if (node.type === 'call_expression' || node.type === 'new_expression') {
      const fn = node.type === 'call_expression'
        ? node.childForFieldName('function')
        : node.childForFieldName('constructor')
      if (fn) {
        if (fn.type === 'identifier') {
          calls.push({ name: fn.text, recv: null, row: node.startPosition.row })
        } else if (fn.type === 'member_expression' || fn.type === 'selector_expression') {
          const named = fn.namedChildren
          if (named.length >= 2) {
            calls.push({ name: named[named.length - 1].text, recv: named[0].text, row: node.startPosition.row })
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i), cls)
  }
  visit(tree.rootNode, null)
  return { symbols, calls }
}
