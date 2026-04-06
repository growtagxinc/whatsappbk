const axios = require('axios');

const PAPERCLIP_URL = process.env.PAPERCLIP_API_URL || 'http://localhost:3000/api';
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

let client = null;

function getClient() {
    if (!client) {
        client = axios.create({
            baseURL: PAPERCLIP_URL,
            timeout: 15000,
        });
    }
    return client;
}

/**
 * Health check - is Paperclip AI running?
 */
async function isHealthy() {
    try {
        const res = await getClient().get('/health');
        return res.data.status === 'ok';
    } catch {
        return false;
    }
}

/**
 * Get company info
 */
async function getCompany(companyId = COMPANY_ID) {
    const res = await getClient().get(`/companies/${companyId}`);
    return res.data;
}

/**
 * List all agents in the company
 */
async function listAgents(companyId = COMPANY_ID) {
    const res = await getClient().get(`/companies/${companyId}/agents`);
    // API returns array directly
    return Array.isArray(res.data) ? res.data : res.data.agents;
}

/**
 * Get a single agent by ID
 */
async function getAgent(agentId) {
    const res = await getClient().get(`/agents/${agentId}`);
    return res.data;
}

/**
 * Create a new issue/task
 */
async function createIssue({ title, description, status = 'todo', priority = 'medium', assigneeAgentId, companyId = COMPANY_ID }) {
    const payload = { title };
    if (description) payload.description = description;
    if (status) payload.status = status;
    if (priority) payload.priority = priority;
    if (assigneeAgentId) payload.assigneeAgentId = assigneeAgentId;

    const res = await getClient().post(`/companies/${companyId}/issues`, payload);
    return res.data;
}

/**
 * List issues in the company
 */
async function listIssues({ status, priority, assigneeAgentId, companyId = COMPANY_ID } = {}) {
    const params = {};
    if (status) params.status = status;
    if (priority) params.priority = priority;
    if (assigneeAgentId) params.assigneeAgentId = assigneeAgentId;

    const res = await getClient().get(`/companies/${companyId}/issues`, { params });
    // API returns array directly
    return Array.isArray(res.data) ? res.data : res.data.issues;
}

/**
 * Get a single issue by ID or identifier
 */
async function getIssue(issueId) {
    const res = await getClient().get(`/issues/${issueId}`);
    return res.data;
}

/**
 * Update an issue (change status, priority, assignee, etc.)
 */
async function updateIssue(issueId, updates) {
    const res = await getClient().patch(`/issues/${issueId}`, updates);
    return res.data;
}

/**
 * Checkout an issue (delegate to an agent)
 */
async function checkoutIssue(issueId, agentId) {
    const res = await getClient().post(`/issues/${issueId}/checkout`, {
        agentId,
        expectedStatuses: ['todo', 'backlog'],
    });
    return res.data;
}

/**
 * Release an issue (unassign agent)
 */
async function releaseIssue(issueId) {
    const res = await getClient().post(`/issues/${issueId}/release`);
    return res.data;
}

/**
 * Add a comment to an issue
 */
async function addComment(issueId, body) {
    const res = await getClient().post(`/issues/${issueId}/comments`, { body });
    return res.data;
}

/**
 * Get all goals in the company
 */
async function listGoals(companyId = COMPANY_ID) {
    const res = await getClient().get(`/companies/${companyId}/goals`);
    return Array.isArray(res.data) ? res.data : res.data.goals;
}

/**
 * Create a goal
 */
async function createGoal({ title, description, level = 'task', companyId = COMPANY_ID }) {
    const res = await getClient().post(`/companies/${companyId}/goals`, {
        title,
        description,
        level,
    });
    return res.data;
}

/**
 * Get the org chart hierarchy
 */
async function getOrgChart(companyId = COMPANY_ID) {
    const res = await getClient().get(`/companies/${companyId}/org`);
    return res.data;
}

/**
 * Pause an agent
 */
async function pauseAgent(agentId) {
    const res = await getClient().post(`/agents/${agentId}/pause`);
    return res.data;
}

/**
 * Resume a paused agent
 */
async function resumeAgent(agentId) {
    const res = await getClient().post(`/agents/${agentId}/resume`);
    return res.data;
}

/**
 * Wake up an agent (trigger heartbeat)
 */
async function wakeupAgent(agentId) {
    const res = await getClient().post(`/agents/${agentId}/wakeup`);
    return res.data;
}

module.exports = {
    isHealthy,
    getCompany,
    listAgents,
    getAgent,
    createIssue,
    listIssues,
    getIssue,
    updateIssue,
    checkoutIssue,
    releaseIssue,
    addComment,
    listGoals,
    createGoal,
    getOrgChart,
    pauseAgent,
    resumeAgent,
    wakeupAgent,
};
