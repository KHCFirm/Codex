// api/generate-pdf.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const config = {
  // Ensure Node runtime (pdfkit + child_process won't work on Edge)
  runtime: 'nodejs20.x',
  // Optional hardening for larger projects; tune per your Vercel plan
  memory: 1024,
  maxDuration: 60
};

function getProjectId(req) {
  // Vercel adds req.query in Node functions; also fall back to parsing URL
  const fromQuery = req?.query?.projectId;
  if (fromQuery != null) return String(fromQuery).trim();
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    return (url.searchParams.get('projectId') || '').trim();
  } catch {
    return '';
  }
}

function todayPart() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return;
  }

  const projectId = getProjectId(req);
  if (!projectId) {
    res.statusCode = 400;
    res.setHeader('content-type', 'text/plain');
    res.end('Missing ?projectId');
    return;
  }

  // Run the existing CLI in /tmp so it writes the PDF where we can read it
  const cliPath = path.join(process.cwd(), 'generate-pdf.mjs');
  const child = spawn(process.execPath, [cliPath, String(projectId)], {
    cwd: '/tmp',
    env: process.env,              // pass through your FILEVINE_* env vars
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const exitCode = await new Promise((resolve) => child.on('close', resolve));

  if (exitCode !== 0) {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain');
    res.end(
      `PDF generation failed (exit ${exitCode}).\n\n` +
      (stderr || stdout || '[no logs]')
    );
    return;
  }

  // The CLI names the file: project-{id}-notes-emails-{YYYY-MM-DD}.pdf
  // It uses process.cwd(), which we set to /tmp
  let filename = `project-${projectId}-notes-emails-${todayPart()}.pdf`;
  let filePath = path.join('/tmp', filename);

  if (!fs.existsSync(filePath)) {
    // Fallback: find the most recent matching file if date rolled over, etc.
    const matches = fs
      .readdirSync('/tmp')
      .filter(
        (n) =>
          n.startsWith(`project-${projectId}-notes-emails-`) && n.endsWith('.pdf')
      )
      .sort();
    if (matches.length) {
      filename = matches[matches.length - 1];
      filePath = path.join('/tmp', filename);
    }
  }

  if (!fs.existsSync(filePath)) {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain');
    res.end(
      `PDF not found at ${filePath}.\n\n` +
        'CLI stdout:\n' + stdout + '\n\nCLI stderr:\n' + stderr
    );
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await pipeline(fs.createReadStream(filePath), res);
}
