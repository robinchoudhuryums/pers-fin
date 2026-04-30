'use strict';

// Haku dragon SVG paths (pixel art style, converted from new reference)
// SVG stored as separate file, loaded at startup for template embedding
// Original viewBox: 0 0 706 1158

const fs = require('fs');
const path = require('path');

let _dragonSVG = '';

// Load SVG at module init, extract just the path elements (skip background and checkerboard)
try {
  const svgContent = fs.readFileSync(path.join(__dirname, 'haku-dragon.svg'), 'utf8');
  // Extract path elements, filtering out background rect and checkerboard tiles
  const pathRegex = /<path\s+d="([^"]+)"\s+fill="([^"]+)"\s*\/>/g;

  function parseHex(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
  }

  let match;
  const paths = [];
  while ((match = pathRegex.exec(svgContent)) !== null) {
    const [, d, fill] = match;
    // Skip background rectangle
    if (d.trim() === 'M0 0h706v1158H0V0Z') continue;
    const [r, g, b] = parseHex(fill);
    const minCh = Math.min(r, g, b);
    const spread = Math.max(r, g, b) - minCh;
    // Skip near-white fills (background/checker) — dragon body is #E3E3E3 (min 227)
    if (minCh >= 220) continue;
    // Skip checkerboard grid tiles (20px stepping pattern) with light fills
    if (minCh >= 210 && /[hv]-?20/.test(d)) continue;
    // Skip anti-aliasing transition colors (high spread = blending between bg and dragon)
    if (minCh >= 210 && spread > 12) continue;
    // Skip small edge fringe fragments
    if (minCh >= 210 && d.length < 40) continue;
    // Skip desaturated gray gap fills between body segments (e.g. between arm and body)
    if (minCh >= 200 && spread <= 12 && d.length < 120) continue;
    // Skip warm beige whisker/antler background bleeds (head region, y < 400)
    const coordMatch = d.match(/^[Mm]\s*(\d+)\s+(\d+)/);
    if (coordMatch && parseInt(coordMatch[2]) < 400 && minCh >= 190 && spread >= 25 && d.length > 200) continue;
    paths.push(`<path d="${d}" fill="${fill}"/>`);
  }
  _dragonSVG = paths.join('\n');
} catch (e) {
  // Fallback: empty dragon if SVG file not found
  _dragonSVG = '<!-- haku-dragon.svg not found -->';
}

function getDragonSVG() {
  return _dragonSVG;
}

// No mask needed for pixel art version
function getDragonMask() {
  return '';
}

module.exports = { getDragonSVG, getDragonMask };
