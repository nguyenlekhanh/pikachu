/**
 * Tile glyph catalogue. Emoji keeps the overlay dependency-free and stays
 * readable on a phone screen; each type also has an accent colour for the tile
 * background so pairs are recognisable at a glance.
 */

export const TILE_TYPES = [
  { id: 0, glyph: '⚡', name: 'bolt', color: '#f6c445', color2: '#b78211' },
  { id: 1, glyph: '🍎', name: 'apple', color: '#ef5b5b', color2: '#a52a2a' },
  { id: 2, glyph: '🌟', name: 'star', color: '#ffd966', color2: '#c79a12' },
  { id: 3, glyph: '🍀', name: 'clover', color: '#5fd068', color2: '#227a30' },
  { id: 4, glyph: '🎈', name: 'balloon', color: '#ff8fb1', color2: '#c2346f' },
  { id: 5, glyph: '🍩', name: 'donut', color: '#f9a05c', color2: '#b0551f' },
  { id: 6, glyph: '🐟', name: 'fish', color: '#5cb8f9', color2: '#1f5f96' },
  { id: 7, glyph: '💎', name: 'gem', color: '#7be0e0', color2: '#1f8f9c' },
  { id: 8, glyph: '🍓', name: 'berry', color: '#f0556d', color2: '#a11f3a' },
  { id: 9, glyph: '🔔', name: 'bell', color: '#ffcf4d', color2: '#a97800' },
  { id: 10, glyph: '🎵', name: 'note', color: '#b18cff', color2: '#5a34b8' },
  { id: 11, glyph: '🚀', name: 'rocket', color: '#8fb8ff', color2: '#2b4b9c' },
  { id: 12, glyph: '🧩', name: 'puzzle', color: '#9be36d', color2: '#3b7a1c' },
  { id: 13, glyph: '🍊', name: 'orange', color: '#ffab42', color2: '#b9660b' },
  { id: 14, glyph: '🌷', name: 'tulip', color: '#ff9ad5', color2: '#b83a83' },
];

export function tileFor(type) {
  return TILE_TYPES[type % TILE_TYPES.length];
}
