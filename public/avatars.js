// Pixel mascots drawn from character grids: one per harness, with a prop for its mood.
const palette = { O:'#d97757', o:'#b85f43', K:'#2b2620', D:'#3b3f46', d:'#2a2d33', T:'#7dd3c0', A:'#9aa0a8', W:'#fffdf8', R:'#c0443a', L:'#8a8f98', S:'#c9c2b4', C:'#7a5a3a', Y:'#f2c46d' };

const bodies = {
  claude:[
    '................',
    '................',
    '...OOOOOOOOOO...',
    '...OOOOOOOOOO...',
    '.OOOOKOOOOKOOOO.',
    '.OOOOKOOOOKOOOO.',
    '...OOOOOOOOOO...',
    '...OOOOOOOOOO...',
    '...O.O....O.O...',
    '...O.O....O.O...',
  ],
  codex:[
    '.......A........',
    '.......A........',
    '...DDDDDDDDDD...',
    '...DddddddddD...',
    '...DdTTddTTdD...',
    '...DddddddddD...',
    '...DddWWWWddD...',
    '...DDDDDDDDDD...',
    '....D......D....',
    '....D......D....',
  ],
};
const props = {
  waiting:[[14, 0, 'R'], [14, 1, 'R'], [14, 2, 'R'], [14, 4, 'R']],
  busy:[[4, 10, 'L'], [5, 10, 'L'], [6, 10, 'L'], [7, 10, 'L'], [8, 10, 'L'], [9, 10, 'L'], [10, 10, 'L'], [11, 10, 'L'], [3, 11, 'S'], [4, 11, 'S'], [5, 11, 'S'], [6, 11, 'S'], [7, 11, 'S'], [8, 11, 'S'], [9, 11, 'S'], [10, 11, 'S'], [11, 11, 'S'], [12, 11, 'S']],
  open:[[13, 7, 'W'], [14, 7, 'W'], [13, 8, 'C'], [14, 8, 'C'], [15, 8, 'W'], [13, 9, 'W'], [14, 9, 'W'], [13, 5, 'S'], [14, 4, 'S']],
};
const mood = status => ({ waiting:'waiting', busy:'busy', idle:'open', open:'open' })[status] || (status === 'off' ? 'off' : 'open');

export function avatar(harness, status) {
  const grid = bodies[harness] || bodies.codex;
  const m = mood(status);
  const rects = [];
  grid.forEach((row, y) => [...row].forEach((ch, x) => { if (palette[ch]) rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${palette[ch]}"/>`); }));
  for (const [x, y, c] of props[m] || []) rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${palette[c]}"/>`);
  return `<svg class="mascot ${m}" viewBox="0 0 16 12" shape-rendering="crispEdges" aria-hidden="true">${rects.join('')}</svg>`;
}
