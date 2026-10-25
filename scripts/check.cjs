const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const root = join(__dirname, '..');
function check(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.vercel'].includes(entry.name)) continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) check(file);
    else if (/\.(?:c?js)$/.test(entry.name)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}
check(root);
const config = JSON.parse(readFileSync(join(root, 'vercel.json')));
if (config.builds && config.functions) throw new Error('Vercel cannot combine builds and functions.');
for (const asset of ['index.html', 'verify.html', 'styles.css', 'salesfloor.css', 'app.js', 'verify.js', 'booran-logo.png']) readFileSync(join(root, 'public', asset));
console.log('JavaScript, Vercel configuration and required assets checked. No frontend compilation required.');
