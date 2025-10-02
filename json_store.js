const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

class DatabaseManager {
  constructor() {
    this.dataFilePath = path.join(__dirname, 'data.json');
    this.blobUrl = process.env.BLOB_DATA_URL || '';
    this.blobToken = process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_RW_TOKEN || '';
    // Use Blob only when running on Vercel AND a RW token is configured
    this.useBlob = (process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV)) && Boolean(this.blobToken);
    this.defaultData = { problemStatements: [], registrations: [] };
    this.memoryData = null;
  }

  async init() {
    if (this.useBlob) {
      const current = await this.#readFromSource();
      if (!current) { await this.#atomicWrite(this.defaultData); }
      this.memoryData = current || { ...this.defaultData };
    } else {
      const exists = fs.existsSync(this.dataFilePath);
      if (!exists) { await this.#atomicWrite(this.defaultData); }
      this.memoryData = (await this.#readFromSource()) || { ...this.defaultData };
    }
    const data = this.memoryData || this.defaultData;
    if (!Array.isArray(data.problemStatements) || data.problemStatements.length === 0) { await this.seedProblemStatements(); }
  }

  async close() { return; }

  async #read() {
    if (this.memoryData) { return this.memoryData; }
    return this.#readFromSource();
  }

  async #readFromSource() {
    if (this.useBlob) {
      try {
        let list, get;
        try {
          ({ list } = await import('@vercel/blob'));
        } catch (_) { return { ...this.defaultData }; }
        if (!this.blobToken) { return { ...this.defaultData }; }
        const { blobs } = await list({ token: this.blobToken });
        const target = blobs.find(b => b.pathname === 'data.json');
        if (!target) { return { ...this.defaultData }; }
        const res = await fetch(target.url, { cache: 'no-store' });
        if (!res.ok) return { ...this.defaultData };
        const text = await res.text();
        return JSON.parse(text);
      } catch {
        return { ...this.defaultData };
      }
    }
    try {
      const raw = await fsp.readFile(this.dataFilePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return { ...this.defaultData };
    }
  }

  async #atomicWrite(json) {
    const str = JSON.stringify(json, null, 2);
    // Update in-memory data first for immediate consistency
    this.memoryData = JSON.parse(str);
    if (this.useBlob) {
      // Dynamically import ESM module in CJS context
      let put;
      try {
        ({ put } = await import('@vercel/blob'));
      } catch (_) {
        throw new Error('Vercel Blob SDK not available');
      }
      if (!this.blobToken) {
        throw new Error('BLOB_READ_WRITE_TOKEN is not set');
      }
      const result = await put('data.json', str, {
        access: 'public',
        contentType: 'application/json',
        token: this.blobToken,
        addRandomSuffix: false,
        cacheControlMaxAge: 0
      });
      this.blobUrl = result.url;
    } else {
      const tmpPath = this.dataFilePath + '.tmp';
      await fsp.writeFile(tmpPath, str, 'utf8');
      await fsp.rename(tmpPath, this.dataFilePath);
    }
  }

  // Problem Statements
  async getAllProblemStatements() {
    try {
      const data = (await this.#read()) || this.defaultData;
      const problems = Array.isArray(data.problemStatements) ? data.problemStatements : [];
      const registrations = Array.isArray(data.registrations) ? data.registrations : [];
      const idToCount = new Map();
      registrations.forEach(r => {
        const pid = r?.problemStatementId;
        if (!pid) return;
        idToCount.set(pid, (idToCount.get(pid) || 0) + 1);
      });
      return problems.map(ps => {
        const parsedMax = typeof ps.maxSelections === 'number' ? ps.maxSelections : parseInt(ps.maxSelections || '0', 10) || 0;
        const maxSel = Math.max(1, parsedMax);
        const selected = idToCount.get(ps.id) || 0;
        return {
          id: ps.id,
          title: ps.title,
          description: ps.description,
          max_selections: maxSel,
          category: ps.category || null,
          difficulty: ps.difficulty || null,
          technologies: Array.isArray(ps.technologies) ? ps.technologies : [],
          selected_count: selected,
          is_available: selected < maxSel
        };
      });
    } catch (_) {
      return [];
    }
  }

  async getProblemStatementById(id) {
    const data = await this.#read();
    return data.problemStatements.find(p => p.id === id) || null;
  }

  async createProblemStatement(problemStatement) {
    const data = await this.#read();
    if (data.problemStatements.some(p => p.id === problemStatement.id)) {
      return { id: problemStatement.id, changes: 0 };
    }
    const parsedMax = typeof problemStatement.maxSelections === 'number' ? problemStatement.maxSelections : parseInt(problemStatement.maxSelections || '0', 10) || 0;
    const maxSel = Math.max(1, parsedMax);
    data.problemStatements.push({
      id: problemStatement.id,
      title: problemStatement.title,
      description: problemStatement.description,
      maxSelections: maxSel,
      category: problemStatement.category || null,
      difficulty: problemStatement.difficulty || null,
      technologies: Array.isArray(problemStatement.technologies) ? problemStatement.technologies : []
    });
    await this.#atomicWrite(data);
    return { id: problemStatement.id, changes: 1 };
  }

  async updateProblemStatement(id, updates) {
    const data = await this.#read();
    const idx = data.problemStatements.findIndex(p => p.id === id);
    if (idx === -1) return { id, changes: 0 };
    const current = data.problemStatements[idx];
    const next = { ...current };
    if (updates.title !== undefined) next.title = updates.title;
    if (updates.description !== undefined) next.description = updates.description;
    if (updates.max_selections !== undefined) {
      const parsed = typeof updates.max_selections === 'number' ? updates.max_selections : parseInt(updates.max_selections || '0', 10) || 0;
      next.maxSelections = Math.max(1, parsed);
    }
    if (updates.maxSelections !== undefined) {
      const parsed = typeof updates.maxSelections === 'number' ? updates.maxSelections : parseInt(updates.maxSelections || '0', 10) || 0;
      next.maxSelections = Math.max(1, parsed);
    }
    if (updates.category !== undefined) next.category = updates.category;
    if (updates.difficulty !== undefined) next.difficulty = updates.difficulty;
    if (updates.technologies !== undefined) next.technologies = Array.isArray(updates.technologies) ? updates.technologies : [];
    data.problemStatements[idx] = next;
    await this.#atomicWrite(data);
    return { id, changes: 1 };
  }

  async deleteProblemStatement(id) {
    const data = await this.#read();
    const before = data.problemStatements.length;
    data.problemStatements = data.problemStatements.filter(p => p.id !== id);
    data.registrations = data.registrations.filter(r => r.problemStatementId !== id);
    await this.#atomicWrite(data);
    return { id, changes: before - data.problemStatements.length };
  }

  // Registrations
  async getAllRegistrations() {
    const data = await this.#read();
    const idToPs = new Map(data.problemStatements.map(p => [p.id, p]));
    return data.registrations.map(r => ({
      team_number: r.teamNumber,
      team_name: r.teamName,
      team_leader: r.teamLeader,
      problem_title: idToPs.get(r.problemStatementId)?.title || '',
      problem_category: idToPs.get(r.problemStatementId)?.category || null,
      problem_difficulty: idToPs.get(r.problemStatementId)?.difficulty || null,
      registration_date_time: r.registrationDateTime
    }));
  }

  async getRegistrationsByProblemStatement(problemStatementId) {
    const data = await this.#read();
    const ps = data.problemStatements.find(p => p.id === problemStatementId);
    return data.registrations
      .filter(r => r.problemStatementId === problemStatementId)
      .map(r => ({
        team_number: r.teamNumber,
        team_name: r.teamName,
        team_leader: r.teamLeader,
        problem_title: ps?.title || '',
        registration_date_time: r.registrationDateTime
      }));
  }

  async isTeamNumberTaken(teamNumber) {
    const data = await this.#read();
    const target = String(teamNumber).trim();
    return data.registrations.some(r => String(r.teamNumber).trim() === target);
    }

  async createRegistrationAtomic(registration) {
    // Use a simple file-based lock mechanism to prevent race conditions
    const lockFile = this.dataFilePath + '.lock';
    const maxRetries = 10;
    const retryDelay = 50; // ms
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Try to acquire lock
        if (!this.useBlob) {
          try {
            await fsp.writeFile(lockFile, process.pid.toString(), { flag: 'wx' });
          } catch (e) {
            if (e.code === 'EEXIST') {
              // Lock exists, wait and retry
              await new Promise(resolve => setTimeout(resolve, retryDelay));
              continue;
            }
            throw e;
          }
        }
        
        try {
          // Re-read data after acquiring lock to get latest state
          const data = await this.#readFromSource();
          const target = String(registration.teamNumber).trim();
          
          // Check if team number is already taken
          if (data.registrations.some(r => String(r.teamNumber).trim() === target)) {
            return null;
          }
          
          // Check if problem statement exists
          const ps = data.problemStatements.find(p => p.id === registration.problemStatementId);
          if (!ps) {
            return null;
          }
          
          // Check if problem statement is full
          const current = data.registrations.filter(r => r.problemStatementId === ps.id).length;
          if (current >= ps.maxSelections) {
            return null;
          }
          
          // All checks passed, create registration
          const record = {
            teamNumber: target,
            teamName: registration.teamName,
            teamLeader: registration.teamLeader,
            problemStatementId: registration.problemStatementId,
            registrationDateTime: new Date().toISOString()
          };
          
          data.registrations.push(record);
          await this.#atomicWrite(data);
          return { id: record.teamNumber, changes: 1 };
          
        } finally {
          // Release lock
          if (!this.useBlob) {
            try {
              await fsp.unlink(lockFile);
            } catch (_) {
              // Ignore errors when removing lock file
            }
          }
        }
      } catch (error) {
        if (!this.useBlob) {
          try {
            await fsp.unlink(lockFile);
          } catch (_) {}
        }
        
        if (attempt === maxRetries - 1) {
          throw error;
        }
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    
    throw new Error('Failed to acquire lock for registration after maximum retries');
  }

  async deleteRegistration(teamNumber) {
    const data = await this.#read();
    const target = String(teamNumber).trim();
    const before = data.registrations.length;
    data.registrations = data.registrations.filter(r => String(r.teamNumber).trim() !== target);
    await this.#atomicWrite(data);
    return { changes: before - data.registrations.length };
  }

  async importFromJSON(jsonData) {
    if (!jsonData || !Array.isArray(jsonData.problemStatements)) return;
    const data = await this.#read();
    const newIds = new Set(data.problemStatements.map(p => p.id));
    jsonData.problemStatements.forEach(ps => {
      if (!newIds.has(ps.id)) {
        const parsedMax = typeof ps.maxSelections === 'number' ? ps.maxSelections : parseInt(ps.maxSelections || '0', 10) || 0;
        const maxSel = Math.max(1, parsedMax);
        data.problemStatements.push({
          id: ps.id,
          title: ps.title,
          description: ps.description,
          maxSelections: maxSel,
          category: ps.category || null,
          difficulty: ps.difficulty || null,
          technologies: Array.isArray(ps.technologies) ? ps.technologies : []
        });
      }
    });
    await this.#atomicWrite(data);
  }

  async seedProblemStatements() {
    const defaults = [
      { id: 'ps001', title: 'Secure Authentication System', description: 'Design and implement a multi-factor authentication system with biometric verification, OTP, and secure session management for a banking application.', maxSelections: 2, category: 'Cybersecurity', difficulty: 'Advanced', technologies: ['Node.js', 'React', 'JWT'] },
      { id: 'ps002', title: 'AI-Powered Code Review Assistant', description: 'Develop an intelligent code review tool that uses machine learning to detect bugs, security vulnerabilities, and suggest improvements in real-time.', maxSelections: 2, category: 'Artificial Intelligence', difficulty: 'Advanced', technologies: ['Python', 'TensorFlow'] },
      { id: 'ps003', title: 'Blockchain Supply Chain Tracker', description: 'Create a transparent supply chain management system using blockchain technology to track products from manufacturer to consumer.', maxSelections: 2, category: 'Blockchain', difficulty: 'Intermediate', technologies: ['Ethereum', 'Solidity'] }
    ];
    const data = (await this.#read()) || this.defaultData;
    data.problemStatements = defaults;
    await this.#atomicWrite(data);
  }

  async resetAll() {
    const data = { problemStatements: [], registrations: [] };
    // Re-seed defaults with at least 1 max selection each (already >=1)
    await this.#atomicWrite(data);
    await this.seedProblemStatements();
    return true;
  }
}

module.exports = DatabaseManager;
