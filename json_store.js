const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

class DatabaseManager {
  constructor() {
    this.dataFilePath = path.join(__dirname, 'data.json');
    this.useBlob = process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);
    this.blobUrl = process.env.BLOB_DATA_URL || '';
    this.blobToken = process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_RW_TOKEN || '';
    this.defaultData = { problemStatements: [], registrations: [] };
  }

  async init() {
    if (this.useBlob) {
      const current = await this.#read();
      if (!current) {
        await this.#atomicWrite(this.defaultData);
      }
    } else {
      const exists = fs.existsSync(this.dataFilePath);
      if (!exists) {
        await this.#atomicWrite(this.defaultData);
      }
    }
    const data = (await this.#read()) || this.defaultData;
    if (!Array.isArray(data.problemStatements) || data.problemStatements.length === 0) {
      await this.seedProblemStatements();
    }
  }

  async close() { return; }

  async #read() {
    if (this.useBlob && this.blobUrl) {
      try {
        const res = await fetch(this.blobUrl);
        if (!res.ok) return null;
        const text = await res.text();
        return JSON.parse(text);
      } catch {
        return null;
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
      const result = await put('data.json', {
        access: 'public',
        contentType: 'application/json',
        token: this.blobToken,
        body: str
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
    const data = await this.#read();
    const idToCount = new Map();
    data.registrations.forEach(r => {
      idToCount.set(r.problemStatementId, (idToCount.get(r.problemStatementId) || 0) + 1);
    });
    return data.problemStatements.map(ps => {
      const selected = idToCount.get(ps.id) || 0;
      return {
        id: ps.id,
        title: ps.title,
        description: ps.description,
        max_selections: ps.maxSelections,
        category: ps.category || null,
        difficulty: ps.difficulty || null,
        technologies: ps.technologies || [],
        selected_count: selected,
        is_available: selected < ps.maxSelections
      };
    });
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
    data.problemStatements.push({
      id: problemStatement.id,
      title: problemStatement.title,
      description: problemStatement.description,
      maxSelections: problemStatement.maxSelections,
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
    if (updates.max_selections !== undefined) next.maxSelections = updates.max_selections;
    if (updates.maxSelections !== undefined) next.maxSelections = updates.maxSelections;
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
    return data.registrations.some(r => r.teamNumber === teamNumber);
    }

  async createRegistrationAtomic(registration) {
    const data = await this.#read();
    if (data.registrations.some(r => r.teamNumber === registration.teamNumber)) return null;
    const ps = data.problemStatements.find(p => p.id === registration.problemStatementId);
    if (!ps) return null;
    const current = data.registrations.filter(r => r.problemStatementId === ps.id).length;
    if (current >= ps.maxSelections) return null;
    const record = {
      teamNumber: registration.teamNumber,
      teamName: registration.teamName,
      teamLeader: registration.teamLeader,
      problemStatementId: registration.problemStatementId,
      registrationDateTime: new Date().toISOString()
    };
    data.registrations.push(record);
    await this.#atomicWrite(data);
    return { id: record.teamNumber, changes: 1 };
  }

  async deleteRegistration(teamNumber) {
    const data = await this.#read();
    const before = data.registrations.length;
    data.registrations = data.registrations.filter(r => r.teamNumber !== teamNumber);
    await this.#atomicWrite(data);
    return { changes: before - data.registrations.length };
  }

  async importFromJSON(jsonData) {
    if (!jsonData || !Array.isArray(jsonData.problemStatements)) return;
    const data = await this.#read();
    const newIds = new Set(data.problemStatements.map(p => p.id));
    jsonData.problemStatements.forEach(ps => {
      if (!newIds.has(ps.id)) {
        data.problemStatements.push({
          id: ps.id,
          title: ps.title,
          description: ps.description,
          maxSelections: ps.maxSelections,
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
}

module.exports = DatabaseManager;


