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
  const visit = (node) => {
    if (grammar === 'javascript') {
      if (node.type === 'import_statement' || node.type === 'export_statement') {
        const source = node.childForFieldName('source')
        const fragment = source && firstDescendant(source, 'string_fragment')
        if (fragment) specs.push(fragment.text)
      } else if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function')
        if (fn && (fn.text === 'require' || fn.text === 'import')) {
          const args = node.childForFieldName('arguments')
          const fragment = args && firstDescendant(args, 'string_fragment')
          if (fragment) specs.push(fragment.text)
        }
      }
    } else if (grammar === 'go') {
      if (node.type === 'import_spec') {
        const declared = node.childForFieldName('path')
        const fragment = declared && firstDescendant(declared, 'interpreted_string_literal_content')
        if (fragment) specs.push(fragment.text)
      }
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i))
  }
  visit(tree.rootNode)
  return specs
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
  const lang = await languageFor(ext)
  const grammar = SYNTAX_LANGUAGES[ext]
  const parser = parserFor(grammar, lang)
  const tree = parser.parse(content)
  try {
    return specsFromTree(grammar, tree)
  } finally {
    tree.delete()
  }
}
