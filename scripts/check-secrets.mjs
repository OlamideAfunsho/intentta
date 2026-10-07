// Refuse to commit or push anything that looks like a secret.
//
// Scans the files git would publish (tracked, staged, and untracked files
// that are not ignored) for credential patterns and for file names that
// should never be in a repository. Run by the pre-commit and pre-push hooks
// in .githooks/, and by hand with
//   node scripts/check-secrets.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Tracked files, staged files, and untracked files that are not ignored:
// everything that is, or could become with `git add .`, part of a push.
const files = [...new Set(
  (git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
    + git('diff', '--cached', '--name-only', '-z', '--diff-filter=ACM'))
    .split('\0')
    .filter(Boolean),
)];

const forbiddenNames = [
  /(^|\/)\.env(\..+)?$/,
  /\.(pem|key|p12|pfx|jks|token)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /credentials.*\.json$/i,
  /(^|\/)\.local\//,
];
const allowedNames = [/(^|\/)\.env\.example$/];

const patterns = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['API key with sk- prefix', /\bsk-(ant-)?[A-Za-z0-9_-]{24,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['bearer token literal', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/],
  ['password or secret assignment',
    /\b(pass(word|wd)?|secret|client_secret|api[_-]?key|auth[_-]?token|access[_-]?token)\b\s*[:=]\s*["'][^"'\s${}<>]{8,}["']/i],
  ['URL with embedded credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:[^\s/@"']{3,}@[^\s"']+/i],
];

const findings = [];
for (const file of files) {
  if (forbiddenNames.some((re) => re.test(file)) && !allowedNames.some((re) => re.test(file))) {
    findings.push(`${file}: file name is on the never-commit list`);
    continue;
  }
  let stat;
  try { stat = statSync(file); } catch { continue; }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || /\.(dar|png|jpg|webm|mp4|gif|ico)$/i.test(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes('secret-scan: allow')) return;
    for (const [name, re] of patterns) {
      if (re.test(line)) findings.push(`${file}:${i + 1}: ${name}`);
    }
  });
}

if (findings.length) {
  console.error('Possible secrets found. Nothing was committed or pushed.\n');
  for (const f of findings) console.error('  ' + f);
  console.error('\nRemove the value, or add "secret-scan: allow" to the line if it is a false positive.');
  process.exit(1);
}
console.log(`Secret scan: ${files.length} files checked, nothing found.`);
