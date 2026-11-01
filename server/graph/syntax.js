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
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  go: 'tree-sitter-go/tree-sitter-go.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
  rust: 'tree-sitter-rust/tree-sitter-rust.wasm'
}

/** The JS/TS, Go, Python, and Rust families; each extension maps to its grammar. */
export const SYNTAX_LANGUAGES = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.go': 'go',
  '.py': 'python',
  '.rs': 'rust'
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
  const bindings = []
  const visit = (node) => {
    if (grammar === 'javascript' || grammar === 'typescript' || grammar === 'tsx') {
      if (node.type === 'import_statement' || node.type === 'export_statement') {
        const source = node.childForFieldName('source')
        const fragment = source && firstDescendant(source, 'string_fragment')
        const specText = fragment ? fragment.text : null
        if (specText) specs.push(specText)
        // Local binding names a qualified call may be addressed through:
        // the default import, the namespace alias, and each named import.
        for (let i = 0; i < node.childCount; i++) {
          const clause = node.child(i)
          if (clause.type !== 'import_clause') continue
          for (let j = 0; j < clause.childCount; j++) {
            const part = clause.child(j)
            if (part.type === 'identifier') {
              names.push(part.text)
              if (specText) bindings.push({ name: part.text, spec: specText })
            } else if (part.type === 'namespace_import') {
              for (let k = 0; k < part.childCount; k++) {
                if (part.child(k).type === 'identifier') {
                  names.push(part.child(k).text)
                  if (specText) bindings.push({ name: part.child(k).text, spec: specText })
                }
              }
            } else if (part.type === 'named_imports') {
              for (let k = 0; k < part.childCount; k++) {
                const specifier = part.child(k)
                if (specifier.type !== 'import_specifier') continue
                const alias = specifier.childForFieldName('alias') || specifier.childForFieldName('name')
                if (alias) {
                  names.push(alias.text)
                  if (specText) bindings.push({ name: alias.text, spec: specText })
                }
              }
            }
          }
        }
      } else if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function')
        if (fn && (fn.text === 'require' || fn.text === 'import')) {
          const args = node.childForFieldName('arguments')
          const fragment = args && firstDescendant(args, 'string_fragment')
          const specText = fragment ? fragment.text : null
          if (specText) specs.push(specText)
          // `const x = require('y')` / `const x = await import('y')`: the
          // declarator name is the binding: the visit starts above it, so
          // walk down from any enclosing declarator via field lookup here.
          let parent = node.parent
          while (parent && parent.type === 'await_expression') parent = parent.parent
          if (parent && parent.type === 'variable_declarator') {
            const name = parent.childForFieldName('name')
            if (name) {
              names.push(name.text)
              if (specText) bindings.push({ name: name.text, spec: specText })
            }
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
          const name = alias ? alias.text : path.slice(path.lastIndexOf('/') + 1)
          names.push(name)
          bindings.push({ name, spec: path })
        }
      }
    } else if (grammar === 'python') {
      if (node.type === 'import_statement') {
        for (let i = 0; i < node.childCount; i++) {
          const c = node.child(i)
          if (c.type === 'dotted_name') {
            specs.push(c.text)
            const firstId = c.child(0)
            if (firstId) {
              names.push(firstId.text)
              bindings.push({ name: firstId.text, spec: c.text })
            }
          } else if (c.type === 'aliased_import') {
            const name = c.childForFieldName('name')
            const alias = c.childForFieldName('alias')
            if (name) specs.push(name.text)
            if (alias) {
              names.push(alias.text)
              bindings.push({ name: alias.text, spec: name ? name.text : alias.text })
            }
          }
        }
      } else if (node.type === 'import_from_statement') {
        const mod = node.childForFieldName('module_name')
        const modText = mod ? mod.text : ''
        if (modText) specs.push(modText)
        let pastImport = false
        for (let i = 0; i < node.childCount; i++) {
          const c = node.child(i)
          if (c.type === 'import') {
            pastImport = true
            continue
          }
          if (!pastImport) continue
          if (c.type === 'dotted_name') {
            names.push(c.text)
            if (modText) specs.push(modText + '.' + c.text)
            bindings.push({ name: c.text, spec: modText || c.text })
          } else if (c.type === 'aliased_import') {
            const name = c.childForFieldName('name')
            const alias = c.childForFieldName('alias')
            if (alias) {
              names.push(alias.text)
              bindings.push({ name: alias.text, spec: modText || (name ? name.text : alias.text) })
            }
            if (name && modText) specs.push(modText + '.' + name.text)
          }
        }
      }
    } else if (grammar === 'rust') {
      if (node.type === 'mod_item') {
        if (!node.childForFieldName('body')) {
          const name = node.childForFieldName('name')
          if (name) {
            specs.push('./' + name.text)
            names.push(name.text)
            bindings.push({ name: name.text, spec: './' + name.text })
          }
        }
      } else if (node.type === 'use_declaration') {
        const extractRustUse = (n, prefix = '') => {
          if (!n) return
          if (n.type === 'scoped_use_list') {
            const pathNode = n.childForFieldName('path')
            const listNode = n.childForFieldName('list')
            const p = (prefix ? prefix + '::' : '') + (pathNode ? pathNode.text : '')
            extractRustUse(listNode, p)
          } else if (n.type === 'use_list') {
            for (let i = 0; i < n.childCount; i++) {
              const c = n.child(i)
              if (c.type === 'identifier' || c.type === 'scoped_identifier' || c.type === 'use_as_clause' || c.type === 'scoped_use_list') {
                extractRustUse(c, prefix)
              }
            }
          } else if (n.type === 'use_as_clause') {
            const pathNode = n.childForFieldName('path')
            const aliasNode = n.childForFieldName('alias')
            const full = (prefix ? prefix + '::' : '') + (pathNode ? pathNode.text : '')
            specs.push(full)
            const alias = aliasNode ? aliasNode.text : null
            if (alias) {
              names.push(alias)
              const crateName = full.split('::')[0]
              bindings.push({ name: alias, spec: crateName, full })
            }
          } else if (n.type === 'scoped_identifier') {
            const full = (prefix ? prefix + '::' : '') + n.text
            specs.push(full)
            const name = n.childForFieldName('name')
            if (name) {
              names.push(name.text)
              const crateName = full.split('::')[0]
              bindings.push({ name: name.text, spec: crateName, full })
            }
          } else if (n.type === 'identifier') {
            const full = (prefix ? prefix + '::' : '') + n.text
            specs.push(full)
            names.push(n.text)
            const crateName = full.split('::')[0]
            bindings.push({ name: n.text, spec: crateName, full })
          }
        }
        extractRustUse(node.childForFieldName('argument'))
      }
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i))
  }
  visit(tree.rootNode)
  return { specs, names, bindings }
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
    const { specs: imports, names: importNames, bindings: importBindings } = specsFromTree(grammar, tree)
    const { symbols, calls } = structureFromTree(grammar, tree)
    return { imports, importNames, importBindings, symbols, calls }
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
    if (grammar === 'javascript' || grammar === 'typescript' || grammar === 'tsx') {
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
      } else if (node.type === 'interface_declaration') {
        const name = node.childForFieldName('name')
        if (name) pushSymbol(node, name.text, 'interface')
      } else if (node.type === 'type_alias_declaration') {
        const name = node.childForFieldName('name')
        if (name) pushSymbol(node, name.text, 'type')
      } else if (node.type === 'enum_declaration') {
        const name = node.childForFieldName('name')
        if (name) pushSymbol(node, name.text, 'enum')
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
    } else if (grammar === 'python') {
      if (node.type === 'class_definition') {
        const name = node.childForFieldName('name')
        if (name) {
          pushSymbol(node, name.text, 'class')
          cls = name.text
        }
      } else if (node.type === 'function_definition') {
        const name = node.childForFieldName('name')
        if (name) {
          if (cls) pushSymbol(node, `${cls}.${name.text}`, 'method')
          else pushSymbol(node, name.text, 'function')
        }
      }
    } else if (grammar === 'rust') {
      if (node.type === 'struct_item') {
        const name = node.childForFieldName('name')
        if (name) pushSymbol(node, name.text, 'struct')
      } else if (node.type === 'enum_item') {
        const name = node.childForFieldName('name')
        if (name) pushSymbol(node, name.text, 'enum')
      } else if (node.type === 'trait_item') {
        const name = node.childForFieldName('name')
        if (name) pushSymbol(node, name.text, 'trait')
      } else if (node.type === 'type_item') {
        const name = node.childForFieldName('name')
        if (name) pushSymbol(node, name.text, 'type')
      } else if (node.type === 'impl_item') {
        const typeNode = node.childForFieldName('type')
        if (typeNode) cls = typeNode.text
      } else if (node.type === 'function_item') {
        const name = node.childForFieldName('name')
        if (name) {
          if (cls) pushSymbol(node, `${cls}.${name.text}`, 'method')
          else pushSymbol(node, name.text, 'function')
        }
      }
    }

    if (grammar === 'python') {
      if (node.type === 'call') {
        const fn = node.childForFieldName('function')
        if (fn) {
          if (fn.type === 'identifier') {
            calls.push({ name: fn.text, recv: null, row: node.startPosition.row })
          } else if (fn.type === 'attribute') {
            const obj = fn.childForFieldName('object')
            const attr = fn.childForFieldName('attribute')
            if (attr) {
              calls.push({ name: attr.text, recv: obj ? obj.text : null, row: node.startPosition.row })
            }
          }
        }
      }
    } else if (grammar === 'rust') {
      if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function')
        if (fn) {
          if (fn.type === 'identifier') {
            calls.push({ name: fn.text, recv: null, row: node.startPosition.row })
          } else if (fn.type === 'field_expression') {
            const val = fn.childForFieldName('value')
            const field = fn.childForFieldName('field')
            if (field) {
              calls.push({ name: field.text, recv: val ? val.text : null, row: node.startPosition.row })
            }
          } else if (fn.type === 'scoped_identifier') {
            const pathNode = fn.childForFieldName('path')
            const nameNode = fn.childForFieldName('name')
            if (nameNode) {
              const recv = pathNode
                ? (pathNode.type === 'scoped_identifier' ? (pathNode.childForFieldName('name') || pathNode).text : pathNode.text)
                : null
              calls.push({ name: nameNode.text, recv, row: node.startPosition.row })
            }
          }
        }
      }
    } else {
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
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i), cls)
  }
  visit(tree.rootNode, null)
  return { symbols, calls }
}
