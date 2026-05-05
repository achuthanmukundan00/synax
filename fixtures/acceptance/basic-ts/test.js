const { readFileSync } = require('fs');
const { join } = require('path');

const source = readFileSync(join(__dirname, 'src', 'math.ts'), 'utf-8');
const match = source.match(/return left \+ right(?: - 1)?;/);

if (!match) {
  console.error('Could not find add implementation');
  process.exit(1);
}

if (match[0] !== 'return left + right;') {
  console.error('Expected add(2, 3) to equal 5, got 4');
  process.exit(1);
}

console.log('ok');
