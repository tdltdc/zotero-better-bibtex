import { Translation, TranslatorMetadata, collect } from './lib/translator'

declare const Zotero: any
declare var ZOTERO_TRANSLATOR_INFO: TranslatorMetadata // eslint-disable-line no-var

export function doExport(): void {
  const translation = Translation.Export(ZOTERO_TRANSLATOR_INFO, collect())
  Zotero.BetterBibTeX.generateBibTeX(translation)
  translation.saveAttachments()
  Zotero.write(translation.output.body)
  translation.erase()
}

import * as escape from '../content/escape'

export function detectImport(): boolean {
  if (!Zotero.getHiddenPref('better-bibtex.import')) return false

  const maxChars = 1048576 // 1MB
  const chunk = 4096

  let inComment = false
  let block = ''
  let buffer = ''
  let chr = ''
  let charsRead = 0

  const re = /^\s*@[a-zA-Z]+[({]/
  while ((buffer = Zotero.read(chunk)) && charsRead < maxChars) {
    Zotero.debug(`Scanning ${buffer.length} characters for BibTeX`)
    charsRead += buffer.length
    for (let i=0; i<buffer.length; i++) {
      chr = buffer[i]

      if (inComment && chr !== '\r' && chr !== '\n') continue
      inComment = false

      if (chr === '%') {
        // read until next newline
        block = ''
        inComment = true
      }
      // allow one-line entries
      else if ((chr === '\n' || chr === '\r' || i === (buffer.length - 1)) && block) {
        // check if this is a BibTeX entry
        if (re.test(block)) return true
        block = ''
      }
      else if (!' \n\r\t'.includes(chr)) {
        block += chr
      }
    }
  }
}

function importGroup(group, itemIDs, root = null) {
  const collection = new Zotero.Collection()
  collection.type = 'collection'
  collection.name = group.name
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  collection.children = group.entries.filter(citekey => itemIDs[citekey]).map(citekey => ({type: 'item', id: itemIDs[citekey]}))

  for (const subgroup of group.groups || []) {
    collection.children.push(importGroup(subgroup, itemIDs))
  }

  if (root) collection.complete()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return collection
}

export async function doImport(): Promise<void> {
  const translation = Translation.Import(ZOTERO_TRANSLATOR_INFO)

  let read
  let input = ''
  while ((read = Zotero.read(0x100000)) !== false) { // eslint-disable-line no-magic-numbers
    input += read
  }

  if (translation.preferences.strings && translation.preferences.importBibTeXStrings) input = `${translation.preferences.strings}\n${input}`

  const bib = await Zotero.BetterBibTeX.parseBibTeX(input, translation)
  const errors = bib.errors

  const whitelist = bib.comments
    .filter((comment: string) => comment.startsWith('zotero-better-bibtex:whitelist:'))
    .map((comment: string) => comment.toLowerCase().replace(/\s/g, '').split(':').pop().split(',').filter((key: string) => key))[0]

  const itemIDS = {}
  let imported = 0
  let id = 0
  for (const bibtex of bib.entries) {
    if (bibtex.key && whitelist && !whitelist.includes(bibtex.key.toLowerCase())) continue
    id++

    if (bibtex.key) itemIDS[bibtex.key] = id // Endnote has no citation keys

    try {
      const builder = new translation.ZoteroItem(translation, id, bibtex, bib.jabref, errors)
      const item = builder.import(new Zotero.Item(builder.type))
      if (item) await item.complete()
    }
    catch (err) {
      Zotero.debug('bbt import error:', err)
      errors.push({ message: err.message })
    }

    imported += 1
    Zotero.setProgress(imported / bib.entries.length * 100) // eslint-disable-line no-magic-numbers
  }

  for (const group of bib.jabref.root || []) {
    importGroup(group, itemIDS, true)
  }

  if (errors.length) {
    const item = new Zotero.Item('note')
    item.note = 'Import errors found: <ul>'
    for (const err of errors) {
      item.note += '<li>'
      if (err.line) {
        item.note += `line ${err.line}`
        if (err.column) item.note += `, column ${err.column}`
        item.note += ': '
      }
      item.note += escape.html(err.message)
      if (err.source) {
        item.note += `<pre>${escape.html(err.source)}</pre>`
        Zotero.debug(`import error: ${err.message}\n>>>\n${err.source}\n<<<`)
      }
      item.note += '</li>'
    }
    item.note += '</ul>'
    item.tags = [{ tag: '#Better BibTeX import error', type: 1 }]
    await item.complete()
  }

  Zotero.setProgress(100) // eslint-disable-line no-magic-numbers
}
