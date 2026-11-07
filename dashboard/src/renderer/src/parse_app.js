const fs = require('fs');
const parser = require('@babel/parser');
const code = fs.readFileSync('App.jsx', 'utf8');
try {
  parser.parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'decorators-legacy']
  });
  console.log('PARSE_OK');
} catch (e) {
  console.error('PARSE_ERR', e.message);
  console.error('LOC:', JSON.stringify(e.loc));
  const lines = code.split(/\r?\n/);
  const start = Math.max(0, e.loc.line - 3);
  const end = Math.min(lines.length, e.loc.line + 2);
  for (let i = start; i < end; i++) {
    const marker = i + 1 === e.loc.line ? '>>' : '  ';
    console.error(`${marker} ${i+1}: ${lines[i]}`);
  }
  process.exit(1);
}
