// Monolithic Node.js app serving API and frontend
const express = require('express');
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('./json_store');
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
  windowMs: 15 * 60 * 1000,
  max: 1000,
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

// Teams CSV (optional auto-fill)
const TEAMS_CSV_PATH = path.join(__dirname, 'teams.csv');
let teamNumberToTeam = new Map();
function loadTeamsCSV() {
  try {
    if (!fs.existsSync(TEAMS_CSV_PATH)) { teamNumberToTeam = new Map(); return; }
    const content = fs.readFileSync(TEAMS_CSV_PATH, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const [header, ...rows] = lines;
    const expected = 'teamNumber,teamName,teamLeader';
    if (!header || header.trim().toLowerCase() !== expected.toLowerCase()) { teamNumberToTeam = new Map(); return; }
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
  } catch (_) { teamNumberToTeam = new Map(); }
}
loadTeamsCSV();

// SSE for live updates
const connectedClients = new Set();
function broadcastUpdate(type, data) {
  const message = `data: ${JSON.stringify({ type, data, timestamp: new Date().toISOString() })}\n\n`;
  connectedClients.forEach((client) => { try { client.write(message); } catch (_) { connectedClients.delete(client); } });
}

async function initializeDatabase() {
  try {
    await db.init();
    const DATA_FILE = path.join(__dirname, 'data.json');
    if (fs.existsSync(DATA_FILE)) {
      const jsonData = JSON.parse(fs.readFileSync(DATA_FILE));
      const existingProblems = await db.getAllProblemStatements();
      if (existingProblems.length === 0 && jsonData.problemStatements?.length > 0) {
        await db.importFromJSON(jsonData);
      }
    }
  } catch (error) {
    console.error('Error during database initialization:', error);
  }
}

// API
app.get('/api/problem-statements', async (req, res) => {
  try {
    res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
    const statements = await db.getAllProblemStatements();
    const formatted = statements.map((ps) => ({
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

app.get('/api/ip', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.ip || '';
  res.json({ ip });
});

app.get('/api/teams', (req, res) => {
  try {
    res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
    res.json(Array.from(teamNumberToTeam.values()));
  } catch (_) { res.status(500).json({ error: 'Failed to load teams' }); }
});

app.get('/api/teams/:teamNumber', (req, res) => {
  res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
  const team = teamNumberToTeam.get(String(req.params.teamNumber).trim());
  if (!team) return res.status(404).json({ error: 'Team not found' });
  res.json(team);
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Cache-Control' });
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Real-time updates enabled' })}\n\n`);
  connectedClients.add(res);
  const heartbeat = setInterval(() => { try { res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`); } catch (_) { clearInterval(heartbeat); connectedClients.delete(res); } }, 30000);
  req.on('close', () => { clearInterval(heartbeat); connectedClients.delete(res); });
});

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

app.delete('/api/registration/:teamNumber', async (req, res) => {
  try {
    const result = await db.deleteRegistration(req.params.teamNumber);
    if (result.changes === 0) return res.status(404).json({ error: 'Registration not found' });
    try {
      const updatedRegistrations = await db.getAllRegistrations();
      const updatedProblems = await db.getAllProblemStatements();
      broadcastUpdate('deletion', { registrations: updatedRegistrations, problems: updatedProblems, deletedTeamNumber: String(req.params.teamNumber).trim() });
    } catch (_) {}
    res.json({ message: 'Registration deleted successfully' });
  } catch (error) {
    console.error('Error deleting registration:', error);
    res.status(500).json({ error: 'Failed to delete registration' });
  }
});

app.get('/api/registrations', async (req, res) => {
  try {
    res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
    const registrations = await db.getAllRegistrations();
    res.json(registrations);
  } catch (error) {
    console.error('Error fetching registrations:', error);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

// Export endpoints (HTML-to-print)
app.get('/api/export/registrations/pdf', async (req, res) => {
  try {
    const registrations = await db.getAllRegistrations();
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Registrations</title><style>body{font-family:Arial;padding:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px}th{background:#c10016;color:#fff}</style></head><body><h1>Registrations</h1>${registrations.length?`<table><thead><tr><th>Team #</th><th>Team Name</th><th>Leader</th><th>Problem</th><th>Date</th></tr></thead><tbody>${registrations.map(r=>`<tr><td>${r.team_number}</td><td>${r.team_name}</td><td>${r.team_leader}</td><td>${r.problem_title}</td><td>${new Date(r.registration_date_time).toLocaleString('en-IN')}</td></tr>`).join('')}</tbody></table>`:`<p>No registrations.</p>`}</body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'inline; filename="registrations-report.html"');
    res.send(html);
  } catch (error) {
    console.error('Error exporting registrations PDF:', error);
    res.status(500).json({ error: 'Failed to export registrations PDF' });
  }
});

app.get('/api/export/problem-statements/pdf', async (req, res) => {
  try {
    const problems = await db.getAllProblemStatements();
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Problem Statements</title><style>body{font-family:Arial;padding:20px}.card{border:1px solid #ddd;margin-bottom:10px;padding:10px;border-radius:4px}</style></head><body><h1>Problem Statements</h1>${problems.map(p=>`<div class=\"card\"><h3>${p.title}</h3><div>ID: ${p.id} | Category: ${p.category||'N/A'} | Difficulty: ${p.difficulty||'N/A'} | Teams: ${(p.selected_count??p.selectedCount)}/${(p.max_selections??p.maxSelections)} | Status: ${(p.is_available??p.isAvailable)?'Available':'Full'}</div><div style=\"margin-top:6px;\">${p.description}</div></div>`).join('')}</body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'inline; filename="problem-statements-report.html"');
    res.send(html);
  } catch (error) {
    console.error('Error exporting problem statements PDF:', error);
    res.status(500).json({ error: 'Failed to export problem statements PDF' });
  }
});

app.get('/api/export/all/pdf', async (req, res) => {
  try {
    const problems = await db.getAllProblemStatements();
    const registrations = await db.getAllRegistrations();
    const html = `<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>Complete Report</title><style>body{font-family:Arial;padding:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px}th{background:#c10016;color:#fff}.card{border:1px solid #ddd;margin-bottom:10px;padding:10px;border-radius:4px}</style></head><body><h1>Complete Report</h1><h2>Problem Statements</h2>${problems.map(p=>`<div class=\"card\"><strong>${p.title}</strong><div style=\"font-size:12px;color:#555;\">ID: ${p.id} | Category: ${p.category||'N/A'} | Difficulty: ${p.difficulty||'N/A'} | Teams: ${(p.selected_count??p.selectedCount)}/${(p.max_selections??p.maxSelections)} | Status: ${(p.is_available??p.isAvailable)?'Available':'Full'}</div><div style=\"margin-top:6px;\">${p.description}</div></div>`).join('')}<h2>Registrations</h2>${registrations.length?`<table><thead><tr><th>Team #</th><th>Team Name</th><th>Leader</th><th>Problem</th><th>Date</th></tr></thead><tbody>${registrations.map(r=>`<tr><td>${r.team_number}</td><td>${r.team_name}</td><td>${r.team_leader}</td><td>${r.problem_title}</td><td>${new Date(r.registration_date_time).toLocaleDateString('en-IN')}</td></tr>`).join('')}</tbody></table>`:`<p>No registrations.</p>`}</body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'inline; filename="hackathon-complete-report.html"');
    res.send(html);
  } catch (error) {
    console.error('Error exporting complete PDF:', error);
    res.status(500).json({ error: 'Failed to export complete PDF' });
  }
});

// Frontend routes
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'home.html')); });
app.get('/problem', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'problem.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

process.on('SIGINT', async () => { await db.close(); process.exit(0); });

async function startServer() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch(console.error);


