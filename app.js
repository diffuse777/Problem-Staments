// Monolithic Node.js app serving API and frontend
const express = require('express');
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('./json_store');
// Removed puppeteer - using HTML-based PDF generation for Vercel compatibility
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Configure trusted proxy safely (avoid permissive setting)
const TRUST_PROXY = process.env.VERCEL ? 1 : false;
app.set('trust proxy', TRUST_PROXY);

// Add rate limiting (enabled in production only)
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // relaxed limit for production bursts
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.',
  trustProxy: true
});
if (process.env.NODE_ENV === 'production') {
  app.use('/api/', limiter);
}

// Initialize database
const db = new DatabaseManager();

// Load teams from CSV for auto-fill
const TEAMS_CSV_PATH = path.join(__dirname, 'teams.csv');
let teamNumberToTeam = new Map();

function loadTeamsCSV() {
  try {
    if (!fs.existsSync(TEAMS_CSV_PATH)) {
      console.warn('teams.csv not found, team auto-fill disabled');
      teamNumberToTeam = new Map();
      return;
    }
    const content = fs.readFileSync(TEAMS_CSV_PATH, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const [header, ...rows] = lines;
    const expected = 'teamNumber,teamName,teamLeader';
    if (!header || header.trim().toLowerCase() !== expected.toLowerCase()) {
      console.warn('teams.csv header mismatch. Expected:', expected, 'Got:', header);
    }
    const map = new Map();
    rows.forEach((line) => {
      const parts = line.split(',');
      if (parts.length < 3) return;
      const teamNumber = String(parts[0]).trim();
      const teamName = parts[1] !== undefined ? String(parts[1]).trim() : '';
      const teamLeader = parts[2] !== undefined ? String(parts[2]).trim() : '';
      if (!teamNumber) return;
      map.set(teamNumber, { teamNumber, teamName, teamLeader });
    });
    teamNumberToTeam = map;
    console.log(`✅ Loaded ${teamNumberToTeam.size} teams from teams.csv`);
  } catch (err) {
    console.error('Failed to load teams.csv:', err);
    teamNumberToTeam = new Map();
  }
}

// Initial load and watch for changes in development
loadTeamsCSV();
try {
  fs.watch(TEAMS_CSV_PATH, { persistent: false }, () => {
    console.log('↻ Detected change in teams.csv, reloading...');
    loadTeamsCSV();
  });
} catch (_) {
  // fs.watch may throw if file does not exist initially; ignore
}

// Store connected clients for real-time updates
const connectedClients = new Set();

// Function to broadcast updates to all connected clients
function broadcastUpdate(type, data) {
  const message = `data: ${JSON.stringify({ type, data, timestamp: new Date().toISOString() })}\n\n`;
  
  connectedClients.forEach(client => {
    try {
      client.write(message);
    } catch (error) {
      console.error('Error sending update to client:', error);
      connectedClients.delete(client);
    }
  });
  
  console.log(`📡 Broadcasted ${type} update to ${connectedClients.size} clients`);
}

// Initialize database and migrate data (lightweight)
async function initializeDatabase() {
  try {
    await db.init();
    const DATA_FILE = path.join(__dirname, 'data.json');
    if (fs.existsSync(DATA_FILE)) {
      const jsonData = JSON.parse(fs.readFileSync(DATA_FILE));
      const existingProblems = await db.getAllProblemStatements();
      if (existingProblems.length === 0 && jsonData.problemStatements?.length > 0) {
        console.log('⚠️  MIGRATION: Importing initial problem statements from JSON...');
        await db.importFromJSON(jsonData);
        console.log('✅ Data import completed');
      }
    }
  } catch (error) {
    console.error('Error during database initialization:', error);
  }
}

// API: Get all problem statements
app.get('/api/problem-statements', async (req, res) => {
  try {
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    const statements = await db.getAllProblemStatements();
    const formatted = statements.map(ps => ({
      ...ps,
      technologies: Array.isArray(ps.technologies) ? ps.technologies : (ps.technologies ? ps.technologies : []),
      selectedCount: typeof ps.selected_count === 'number' ? ps.selected_count : parseInt(ps.selected_count),
      maxSelections: typeof ps.max_selections === 'number' ? ps.max_selections : parseInt(ps.max_selections),
      isAvailable: Boolean(ps.is_available)
    }));
    res.json(formatted);
  } catch (error) {
    console.error('Error fetching problem statements:', error);
    res.status(500).json({ error: 'Failed to fetch problem statements' });
  }
});

// API: Get client IP address
// Utility to normalize and extract best client IP across common proxy/CDN headers
function normalizeIp(ip) {
  if (!ip) return '';
  const noScope = String(ip).split('%')[0].trim();
  if (noScope === '::1') return '127.0.0.1';
  if (noScope.startsWith('::ffff:')) return noScope.replace('::ffff:', '');
  const bracketMatch = noScope.match(/^\[(.*)\]$/);
  if (bracketMatch) return bracketMatch[1];
  return noScope;
}
function getClientIp(req) {
  // Priority order for typical deployments
  const headerCandidates = [
    req.headers['cf-connecting-ip'],       // Cloudflare
    req.headers['true-client-ip'],         // Akamai
    req.headers['x-real-ip'],              // Nginx/Ingress
    req.headers['x-client-ip'],
    req.headers['fastly-client-ip'],       // Fastly
    req.headers['fly-client-ip'],          // Fly.io
    req.headers['x-forwarded-for']         // Standard chain (take first)
  ];
  let fromHeaders = headerCandidates.find(Boolean);
  if (Array.isArray(fromHeaders)) fromHeaders = fromHeaders[0];
  if (typeof fromHeaders === 'string' && fromHeaders.includes(',')) {
    fromHeaders = fromHeaders.split(',')[0].trim();
  }
  const raw = fromHeaders || req.socket?.remoteAddress || req.ip || req.connection?.remoteAddress;
  return normalizeIp(raw);
}

app.get('/api/ip', (req, res) => {
  const ip = getClientIp(req);
  res.json({ ip });
});

// API: Teams list and lookup for auto-fill
app.get('/api/teams', (req, res) => {
  try {
    // Prevent caching
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    
    const teams = Array.from(teamNumberToTeam.values());
    res.json(teams);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load teams' });
  }
});

app.get('/api/teams/:teamNumber', (req, res) => {
  // Prevent caching
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  
  const { teamNumber } = req.params;
  const team = teamNumberToTeam.get(String(teamNumber).trim());
  if (!team) return res.status(404).json({ error: 'Team not found' });
  res.json(team);
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Server-Sent Events endpoint for real-time updates
app.get('/api/events', (req, res) => {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Real-time updates enabled' })}\n\n`);

  // Add client to connected clients
  connectedClients.add(res);

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`);
    } catch (error) {
      clearInterval(heartbeat);
      connectedClients.delete(res);
    }
  }, 30000);

  // Handle client disconnect
  req.on('close', () => {
    console.log('📡 Client disconnected from real-time updates');
    clearInterval(heartbeat);
    connectedClients.delete(res);
  });

  console.log(`📡 New client connected to real-time updates. Total clients: ${connectedClients.size}`);
});

// API: Register a team
app.post('/api/register', async (req, res) => {
  try {
    const { teamNumber, teamName, teamLeader, problemStatementId } = req.body;
    if (!teamNumber || !teamName || !teamLeader || !problemStatementId) {
      return res.status(400).json({ error: 'Missing required fields: teamNumber, teamName, teamLeader, problemStatementId' });
    }
    const isTaken = await db.isTeamNumberTaken(teamNumber);
    if (isTaken) return res.status(409).json({ error: 'Team number already registered.' });
    const ps = await db.getProblemStatementById(problemStatementId);
    if (!ps) return res.status(404).json({ error: 'Problem statement not found.' });
    const registration = await db.createRegistrationAtomic({ teamNumber, teamName, teamLeader, problemStatementId });
    if (!registration) return res.status(409).json({ error: 'Problem statement is full or team already registered.' });
    try {
      const updatedRegistrations = await db.getAllRegistrations();
      const updatedProblems = await db.getAllProblemStatements();
      broadcastUpdate('registration', { registrations: updatedRegistrations, problems: updatedProblems, newRegistration: { ...registration, problemStatement: ps } });
    } catch (_) {}
    res.json({ message: 'Registration successful!', registration: { ...registration, problemStatement: ps } });
  } catch (error) {
    console.error('Error during registration:', error);
    res.status(500).json({ error: 'Registration failed', details: error.message });
  }
});

// API: Remove a registration (admin only)
app.delete('/api/registration/:teamNumber', async (req, res) => {
  try {
    const { teamNumber } = req.params;
    const result = await db.deleteRegistration(teamNumber);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Registration not found' });
    }
    // broadcast update
    try {
      const updatedRegistrations = await db.getAllRegistrations();
      const updatedProblems = await db.getAllProblemStatements();
      broadcastUpdate('registration-delete', { registrations: updatedRegistrations, problems: updatedProblems, teamNumber });
    } catch (_) {}
    res.json({ message: 'Registration deleted successfully' });
  } catch (error) {
    console.error('Error deleting registration:', error);
    res.status(500).json({ error: 'Failed to delete registration' });
  }
});

// Additional API endpoints for database management

// API: Get all registrations (for admin purposes)
app.get('/api/registrations', async (req, res) => {
  try {
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    const registrations = await db.getAllRegistrations();
    res.json(registrations);
  } catch (error) {
    console.error('Error fetching registrations:', error);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

// API: Get registrations by problem statement
app.get('/api/registrations/problem/:problemStatementId', async (req, res) => {
  try {
    const { problemStatementId } = req.params;
    const registrations = await db.getRegistrationsByProblemStatement(problemStatementId);
    res.json(registrations);
  } catch (error) {
    console.error('Error fetching registrations by problem:', error);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

// API: Create a new problem statement (for admin purposes)
app.post('/api/problem-statements', async (req, res) => {
  try {
    const problemStatement = req.body;
    await db.createProblemStatement(problemStatement);
    res.status(201).json({ message: 'Problem statement created successfully', id: problemStatement.id });
  } catch (error) {
    console.error('Error creating problem statement:', error);
    res.status(500).json({ error: 'Failed to create problem statement' });
  }
});

// API: Update a problem statement (for admin purposes)
app.put('/api/problem-statements/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const result = await db.updateProblemStatement(id, updates);
    res.json({ message: 'Problem statement updated successfully' });
  } catch (error) {
    console.error('Error updating problem statement:', error);
    res.status(500).json({ error: 'Failed to update problem statement' });
  }
});

// API: Delete a problem statement (for admin purposes)
app.delete('/api/problem-statements/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.deleteProblemStatement(id);
    res.json({ message: 'Problem statement deleted successfully' });
  } catch (error) {
    console.error('Error deleting problem statement:', error);
    res.status(500).json({ error: 'Failed to delete problem statement' });
  }
});

// Export functionality

// Helper function to convert data to CSV
function convertToCSV(data, headers) {
  if (data.length === 0) return '';
  
  const csvHeaders = headers.join(',');
  const csvRows = data.map(row => 
    headers.map(header => {
      const value = row[header];
      // Escape commas and quotes in CSV
      if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value || '';
    }).join(',')
  );
  
  return [csvHeaders, ...csvRows].join('\n');
}

// API: Export registrations as CSV
app.get('/api/export/registrations/csv', async (req, res) => {
  try {
    const registrations = await db.getAllRegistrations();
    const headers = ['team_number', 'team_name', 'team_leader', 'problem_title', 'problem_category', 'problem_difficulty', 'registration_date_time'];
    const csvHeaders = headers.join(',');
    const csvRows = registrations.map(row => headers.map(h => {
      const v = row[h];
      if (typeof v === 'string' && (v.includes(',') || v.includes('"') || v.includes('\n'))) return '"' + v.replace(/"/g, '""') + '"';
      return v || '';
    }).join(',')).join('\n');
    const csv = [csvHeaders, csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="registrations.csv"');
    res.send(csv);
  } catch (error) {
    console.error('Error exporting registrations CSV:', error);
    res.status(500).json({ error: 'Failed to export registrations' });
  }
});

// API: Export problem statements as CSV
app.get('/api/export/problem-statements/csv', async (req, res) => {
  try {
    const problems = await db.getAllProblemStatements();
    const headers = ['id', 'title', 'description', 'max_selections', 'selected_count', 'is_available', 'category', 'difficulty', 'technologies'];
    const csvHeaders = headers.join(',');
    const csvRows = problems.map(row => headers.map(h => {
      const v = row[h];
      const s = typeof v === 'object' ? JSON.stringify(v) : v;
      if (typeof s === 'string' && (s.includes(',') || s.includes('"') || s.includes('\n'))) return '"' + s.replace(/"/g, '""') + '"';
      return s || '';
    }).join(',')).join('\n');
    const csv = [csvHeaders, csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="problem-statements.csv"');
    res.send(csv);
  } catch (error) {
    console.error('Error exporting problem statements CSV:', error);
    res.status(500).json({ error: 'Failed to export problem statements' });
  }
});

// API: Export all data as JSON
app.get('/api/export/all/json', async (req, res) => {
  try {
    const problems = await db.getAllProblemStatements();
    const registrations = await db.getAllRegistrations();
    const exportData = {
      exportDate: new Date().toISOString(),
      problemStatements: problems,
      registrations: registrations,
      summary: {
        totalProblems: problems.length,
        totalRegistrations: registrations.length,
        availableProblems: problems.filter(p => p.is_available).length,
        fullProblems: problems.filter(p => !p.is_available).length
      }
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="hackathon-data.json"');
    res.json(exportData);
  } catch (error) {
    console.error('Error exporting all data JSON:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// API: Export registrations as JSON
app.get('/api/export/registrations/json', async (req, res) => {
  try {
    const registrations = await db.getAllRegistrations();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="registrations.json"');
    res.json(registrations);
  } catch (error) {
    console.error('Error exporting registrations JSON:', error);
    res.status(500).json({ error: 'Failed to export registrations' });
  }
});

// API: Export problem statements as JSON
app.get('/api/export/problem-statements/json', async (req, res) => {
  try {
    const problems = await db.getAllProblemStatements();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="problem-statements.json"');
    res.json(problems);
  } catch (error) {
    console.error('Error exporting problem statements JSON:', error);
    res.status(500).json({ error: 'Failed to export problem statements' });
  }
});

// PDF Export functionality

// Helper function to generate PDF (HTML-based for Vercel compatibility)
function generatePDF(html, filename) {
  try {
    // Create a complete HTML document with print styles
    const fullHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${filename}</title>
    <style>
        @media print {
            body { margin: 0; padding: 20px; font-family: Arial, sans-serif; font-size: 12px; }
            .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #333; padding-bottom: 10px; }
            .content { margin: 20px 0; }
            table { width: 100%; border-collapse: collapse; margin: 10px 0; }
            th, td { border: 1px solid #ddd; padding: 6px; text-align: left; font-size: 11px; }
            th { background-color: #f2f2f2; font-weight: bold; }
            .footer { margin-top: 30px; text-align: center; font-size: 10px; color: #666; }
            .page-break { page-break-before: always; }
        }
        body { margin: 0; padding: 20px; font-family: Arial, sans-serif; font-size: 12px; }
        .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #333; padding-bottom: 10px; }
        .content { margin: 20px 0; }
        table { width: 100%; border-collapse: collapse; margin: 10px 0; }
        th, td { border: 1px solid #ddd; padding: 6px; text-align: left; font-size: 11px; }
        th { background-color: #f2f2f2; font-weight: bold; }
        .footer { margin-top: 30px; text-align: center; font-size: 10px; color: #666; }
        .page-break { page-break-before: always; }
    </style>
</head>
<body>
    ${html}
    <div class="footer">
        Generated on ${new Date().toLocaleString('en-IN', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true,
          timeZone: 'Asia/Kolkata'
        })} IST | Hackathon Registration System
    </div>
</body>
</html>`;
    
    return Buffer.from(fullHTML, 'utf8');
  } catch (error) {
    console.error('PDF generation error:', error);
    throw error;
  }
}

// API: Export registrations as PDF
app.get('/api/export/registrations/pdf', async (req, res) => {
  try {
    const registrations = await db.getAllRegistrations();
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Hackathon Registrations Report</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
        .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #c10016; padding-bottom: 20px; }
        .header h1 { color: #c10016; margin: 0; font-size: 28px; }
        .header p { color: #666; margin: 5px 0; }
        .summary { background: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .summary h3 { margin: 0 0 10px 0; color: #333; }
        .summary p { margin: 5px 0; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
        th { background-color: #c10016; color: white; font-weight: bold; }
        tr:nth-child(even) { background-color: #f2f2f2; }
        .no-data { text-align: center; padding: 40px; color: #666; font-style: italic; }
        .footer { margin-top: 30px; text-align: center; color: #666; font-size: 12px; }
        @media print { body { margin: 0; padding: 15px; } table { page-break-inside: avoid; } .page-break { page-break-before: always; } }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>TechFrontier 2K25 - Registrations Report</h1>
        <p>Generated on: ${new Date().toLocaleString('en-IN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })} IST</p>
      </div>
      <div class="summary">
        <h3>Summary</h3>
        <p><strong>Total Registrations:</strong> ${registrations.length}</p>
      </div>
      ${registrations.length > 0 ? `
      <table>
        <thead>
          <tr>
            <th>Team #</th>
            <th>Team Name</th>
            <th>Team Leader</th>
            <th>Problem Statement</th>
            <th>Registration Date</th>
          </tr>
        </thead>
        <tbody>
          ${registrations.map(reg => `
            <tr>
              <td>${reg.team_number}</td>
              <td>${reg.team_name}</td>
              <td>${reg.team_leader}</td>
              <td>${reg.problem_title}</td>
              <td>${new Date(reg.registration_date_time).toLocaleString('en-IN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })} IST</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ` : `
      <div class="no-data"><p>No registrations found.</p></div>
      `}
      <div class="footer"><p>TechFrontier 2K25 Hackathon Management System</p></div>
    </body>
    </html>`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'inline; filename="registrations-report.html"');
    res.send(html);
  } catch (error) {
    console.error('Error exporting registrations PDF:', error);
    res.status(500).json({ error: 'Failed to export registrations PDF' });
  }
});

// API: Export problem statements as PDF
app.get('/api/export/problem-statements/pdf', async (req, res) => {
  try {
    const problems = await db.getAllProblemStatements();
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Hackathon Problem Statements Report</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
        .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #c10016; padding-bottom: 20px; }
        .header h1 { color: #c10016; margin: 0; font-size: 28px; }
        .header p { color: #666; margin: 5px 0; }
        .problem-card { border: 1px solid #ddd; margin-bottom: 20px; padding: 15px; border-radius: 5px; }
        .problem-card h3 { color: #c10016; margin: 0 0 10px 0; }
        .problem-meta { display: flex; gap: 20px; margin-bottom: 10px; flex-wrap: wrap; }
        .problem-meta span { background: #e9ecef; padding: 5px 10px; border-radius: 3px; font-size: 12px; }
        .problem-description { margin: 10px 0; line-height: 1.5; }
        .tech-tag { display: inline-block; background: #c10016; color: white; padding: 3px 8px; margin: 2px; border-radius: 3px; font-size: 11px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>TechFrontier 2K25 - Problem Statements Report</h1>
        <p>Generated on: ${new Date().toLocaleString('en-IN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })} IST</p>
      </div>
      ${problems.map(p => `
        <div class=\"problem-card\">
          <h3>${p.title}</h3>
          <div class=\"problem-meta\">
            <span><strong>ID:</strong> ${p.id}</span>
            <span><strong>Category:</strong> ${p.category || 'N/A'}</span>
            <span><strong>Difficulty:</strong> ${p.difficulty || 'N/A'}</span>
            <span><strong>Teams:</strong> ${(p.selected_count ?? p.selectedCount)}/${(p.max_selections ?? p.maxSelections)}</span>
            <span><strong>Status:</strong> ${(p.is_available ?? p.isAvailable) ? 'Available' : 'Full'}</span>
          </div>
          <div class=\"problem-description\">${p.description}</div>
          ${Array.isArray(p.technologies) && p.technologies.length ? `
            <div><strong>Technologies:</strong> ${p.technologies.map(t => `<span class=\"tech-tag\">${t}</span>`).join('')}</div>
          ` : ''}
        </div>
      `).join('')}
    </body>
    </html>`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'inline; filename="problem-statements-report.html"');
    res.send(html);
  } catch (error) {
    console.error('Error exporting problem statements PDF:', error);
    res.status(500).json({ error: 'Failed to export problem statements PDF' });
  }
});

// API: Export all data as PDF
app.get('/api/export/all/pdf', async (req, res) => {
  try {
    const problems = await db.getAllProblemStatements();
    const registrations = await db.getAllRegistrations();
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Hackathon Complete Report</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
        .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #c10016; padding-bottom: 20px; }
        .header h1 { color: #c10016; margin: 0; font-size: 28px; }
        .header p { color: #666; margin: 5px 0; }
        .section { margin: 30px 0; }
        .section h2 { color: #c10016; border-bottom: 1px solid #ddd; padding-bottom: 10px; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 12px; }
        th { background-color: #c10016; color: white; font-weight: bold; }
        tr:nth-child(even) { background-color: #f2f2f2; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>TechFrontier 2K25 - Complete Report</h1>
        <p>Generated on: ${new Date().toLocaleString('en-IN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })} IST</p>
      </div>
      <div class="section">
        <h2>Problem Statements</h2>
        ${problems.map(p => `
          <div style=\"border:1px solid #ddd; margin-bottom: 10px; padding: 10px; border-radius: 4px;\">
            <strong>${p.title}</strong>
            <div style=\"font-size:12px;color:#555;\">ID: ${p.id} | Category: ${p.category || 'N/A'} | Difficulty: ${p.difficulty || 'N/A'} | Teams: ${(p.selected_count ?? p.selectedCount)}/${(p.max_selections ?? p.maxSelections)} | Status: ${(p.is_available ?? p.isAvailable) ? 'Available' : 'Full'}</div>
            <div style=\"margin-top:6px;\">${p.description}</div>
          </div>
        `).join('')}
      </div>
      <div class="section">
        <h2>Registrations</h2>
        ${registrations.length ? `
          <table>
            <thead>
              <tr>
                <th>Team #</th>
                <th>Team Name</th>
                <th>Leader</th>
                <th>Problem</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              ${registrations.map(reg => `
                <tr>
                  <td>${reg.team_number}</td>
                  <td>${reg.team_name}</td>
                  <td>${reg.team_leader}</td>
                  <td>${reg.problem_title}</td>
                  <td>${new Date(reg.registration_date_time).toLocaleDateString('en-IN')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : `<div>No registrations found.</div>`}
      </div>
    </body>
    </html>`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'inline; filename="hackathon-complete-report.html"');
    res.send(html);
  } catch (error) {
    console.error('Error exporting complete PDF:', error);
    res.status(500).json({ error: 'Failed to export complete PDF' });
  }
});

// Serve frontend

// Serve homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// Serve problem statement page
app.get('/problem', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'problem.html'));
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await db.close();
  process.exit(0);
});

// Start server
async function startServer() {
  await initializeDatabase();
  
  app.listen(PORT, () => {
    console.log(`🚀 Monolithic app running on port ${PORT}`);
    console.log(`🌐 Frontend: http://localhost:${PORT}`);
    console.log(`📋 Problem Selection: http://localhost:${PORT}/problem`);
  });
}

startServer().catch(console.error);
