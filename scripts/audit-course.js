import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { auditRequirements, auditMarkdown, courseIntegrationChecklist } from '../src/course/audit.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Node 22 built-in parser avoids needing runtime dependencies for the audit.
// Never print the values: the checklist records presence of credentials only.
try { loadEnvFile(join(root, '.env')); }
catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') throw error; }
const output = resolve(process.argv[2] || join(root, 'course-audit'));
const audit = auditRequirements({ exists: path => existsSync(join(root, path)) });
await mkdir(output, { recursive: true });
await writeFile(join(output, 'requirements.json'), JSON.stringify(audit, null, 2) + '\n');
await writeFile(join(output, 'requirements.md'), auditMarkdown(audit));
await writeFile(join(output, 'integration-checklist.json'), JSON.stringify(courseIntegrationChecklist(process.env), null, 2) + '\n');
console.log(`Stage 4A audit written to ${output}`);
console.log('Official instructor API and challenge validation are NOT confirmed. See requirements.md.');
