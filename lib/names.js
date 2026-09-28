'use strict'

/*
 * Normalises the free-form country names in the territorial sea dataset
 * (e.g. "United Kingdom 12 NM", "French 12 NM") into plain country names.
 */

const SUFFIX_PATTERNS = [
  /\s*\(\s*12\s*(?:NM|nautical\s+miles?|Nautical\s+Miles)\s*\)\s*$/i,
  /\s*12\s*(?:NM|nautical\s+miles?|Nautical\s+Miles)\s*$/i,
  /\s*territorial\s+sea(?:s)?\s*$/i,
  /\s*territorial\s+waters(?:s)?\s*$/i
]

function normalizeCountryName(raw) {
  if (!raw) return ''
  // Strip NUL bytes (DBF fixed-width padding) and regular whitespace.
  let name = String(raw).replace(/[\u0000\s]+/g, ' ').trim()
  if (!name) return ''
  for (const pattern of SUFFIX_PATTERNS) {
    name = name.replace(pattern, '').trim()
  }
  // A couple of dataset-specific fixes
  name = name.replace(/\s*\(.*\)\s*$/, '').trim()
  if (!name) return String(raw).replace(/[\u0000\s]+/g, ' ').trim()
  return name
}

module.exports = { normalizeCountryName }