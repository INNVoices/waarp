// Reproduce Atlas assets from the two pinned Natural Earth input files.
// Input files must be downloaded explicitly; this script never uses the network.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const inputs = [
  ['ne_110m_admin_0_countries.geojson', '1e6ab74c7042f97013be69ceec798be8e1aff27d'],
  ['ne_50m_admin_0_tiny_countries.geojson', '6e476aa6ba350c1cc0d92453d39ca630b6f2283f']
]
if (process.argv.length !== 4) throw new Error('Usage: node scripts/atlas-data.mjs <110m-countries.geojson> <50m-tiny-countries.geojson>')
const data = inputs.map(([name, expected], index) => {
  const bytes = readFileSync(process.argv[index + 2])
  const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  if (hash !== expected) throw new Error(`${name}: source Git blob mismatch: ${hash}`)
  return JSON.parse(bytes.toString('utf8'))
})
const country = properties => /^[A-Z]{2}$/.test(properties.ISO_A2) ? properties.ISO_A2
  : /^[A-Z]{2}$/.test(properties.ISO_A2_EH) ? properties.ISO_A2_EH : null
const rounded = value => Math.round(value * 1000) / 1000
const coordinates = value => Array.isArray(value) ? value.map(coordinates) : rounded(value)
const anchors = {}
for (const input of data) for (const { properties } of input.features) {
  const code = country(properties)
  if (!code || anchors[code] || !Number.isFinite(properties.LABEL_X) || !Number.isFinite(properties.LABEL_Y)) continue
  anchors[code] = { name: properties.NAME_EN, longitude: rounded(properties.LABEL_X), latitude: rounded(properties.LABEL_Y) }
}
const regions = Object.fromEntries(Object.entries(anchors).sort(([a], [b]) => a.localeCompare(b)))
const world = { type: 'FeatureCollection', features: data[0].features.map(feature => ({
  type: 'Feature', properties: { country: country(feature.properties) },
  geometry: { type: feature.geometry.type, coordinates: coordinates(feature.geometry.coordinates) }
})) }
for (const [name, body] of [['atlas-countries.json', JSON.stringify(regions, null, 2) + '\n'], ['atlas-world.json', JSON.stringify(world) + '\n']]) {
  writeFileSync(fileURLToPath(new URL('../src/shared/' + name, import.meta.url)), body)
  console.log(`${name}: ${Buffer.byteLength(body)} bytes, sha256 ${createHash('sha256').update(body).digest('hex')}`)
}
