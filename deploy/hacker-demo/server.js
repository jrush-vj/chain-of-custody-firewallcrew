#!/usr/bin/env node
/**
 * Demo API backend for the hacker UI.
 * Triggers the server's existing coc.sh attack scripts and returns results.
 * Run: node server.js
 */

import http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const PORT = 3000;
const SERVER_IP = '192.168.31.77';
const SSH_USER = 'jrush-vj'; // Change if needed

// CORS and JSON parsing middleware
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function checkStatus() {
  try {
    const { stdout: server } = await execAsync(
      `curl -s -m 2 http://${SERVER_IP}:3001/ | head -c 20`,
      { shell: '/bin/bash' }
    );
    const { stdout: witness } = await execAsync(
      `curl -s -m 2 http://127.0.0.1:8787/health | head -c 20`,
      { shell: '/bin/bash' }
    );
    const { stdout: ssh } = await execAsync(
      `timeout 2 ssh -o ConnectTimeout=1 ${SSH_USER}@${SERVER_IP} exit 2>&1 || true`,
      { shell: '/bin/bash' }
    );

    return {
      server: server.length > 0,
      witness: witness.includes('status'),
      ssh: !ssh.includes('refused') && !ssh.includes('timeout'),
    };
  } catch {
    return { server: false, witness: false, ssh: false };
  }
}

async function runAttack(layer) {
  const cmd = `ssh -t ${SSH_USER}@${SERVER_IP} "sudo bash /opt/chain-of-custody/deploy/ct105/coc.sh attack ${layer} 2>&1"`;
  try {
    const { stdout, stderr } = await execAsync(cmd, { shell: '/bin/bash', timeout: 60000 });
    return { success: true, output: (stdout + stderr).slice(0, 2000) };
  } catch (error) {
    return { success: false, error: error.message || 'Attack failed' };
  }
}

async function runCommand(cmd) {
  try {
    // Only allow safe commands (no rm, no sudo without explicit attack)
    if (cmd.includes('rm ') || cmd.includes('shutdown')) {
      return { success: false, error: 'Command not allowed' };
    }

    const fullCmd = cmd.startsWith('ssh ')
      ? cmd
      : `ssh ${SSH_USER}@${SERVER_IP} "${cmd}"`;

    const { stdout, stderr } = await execAsync(fullCmd, {
      shell: '/bin/bash',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
    });
    return { success: true, output: (stdout + stderr).slice(0, 2000) };
  } catch (error) {
    return { success: false, error: error.message || 'Command failed' };
  }
}

const server = http.createServer(async (req, res) => {
  res.writeHead(200, corsHeaders);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.end();
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });

  req.on('end', async () => {
    try {
      if (req.url === '/status' && req.method === 'GET') {
        const status = await checkStatus();
        res.end(JSON.stringify(status));
      } else if (req.url === '/attack' && req.method === 'POST') {
        const { layer } = JSON.parse(body);
        if (![1, 2, 3].includes(layer)) {
          res.end(JSON.stringify({ success: false, error: 'Invalid layer' }));
          return;
        }
        const result = await runAttack(layer);
        res.end(JSON.stringify(result));
      } else if (req.url === '/run' && req.method === 'POST') {
        const { cmd } = JSON.parse(body);
        const result = await runCommand(cmd);
        res.end(JSON.stringify(result));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, 'localhost', () => {
  console.log(`\n🔓 Hacker demo API running on http://localhost:${PORT}`);
  console.log(`   Open http://localhost:${PORT} in your browser\n`);
});
