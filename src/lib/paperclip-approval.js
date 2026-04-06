/**
 * Paperclip Approval Notifier & Command Handler
 *
 * How it works:
 * - Polls Paperclip every 5 minutes for items needing approval
 * - Sends you WhatsApp notifications for pending approvals
 * - Handles incoming WhatsApp commands: APPROVE, REJECT, STATUS, HELP
 *
 * Start the notifier from server.js or standalone:
 *   node src/lib/paperclip-approval.js
 */

const axios = require('axios');
const { EventEmitter } = require('events');
const paperclip = require('./paperclip');

const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP_NUMBER || '917678369256';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let sentApprovals = new Set(); // track what we've already notified about

const emitter = new EventEmitter();

// ── Notifier: Check for pending approvals and notify ──────────────────────────

async function checkPendingApprovals(sendFn) {
    try {
        // Get high-priority issues that need review
        const issues = await paperclip.listIssues({ status: 'backlog', priority: 'critical' });
        const agents = await paperclip.listAgents();

        const agentMap = {};
        for (const a of agents) agentMap[a.id] = a.name;

        for (const issue of issues || []) {
            // Skip if we already notified about this
            if (sentApprovals.has(issue.id)) continue;

            const agentName = agentMap[issue.assigneeAgentId] || 'Unknown';
            const msg = `🔴 *APPROVAL NEEDED*

*${issue.title}*
${issue.description ? issue.description.slice(0, 200) + (issue.description.length > 200 ? '...' : '') : ''}

👤 Assigned to: ${agentName}
📌 Priority: ${issue.priority.toUpperCase()}
🔢 ${issue.identifier}

*Reply:* APPROVE ${issue.identifier}
         REJECT ${issue.identifier}
         HELP`;

            await sendFn(ADMIN_NUMBER, msg);
            sentApprovals.add(issue.id);
            console.log(`[ApprovalNotifier] Sent notification for ${issue.identifier} - ${issue.title}`);
            // Rate limit: wait 3s between WhatsApp sends to avoid Meta throttling
            await new Promise(r => setTimeout(r, 3000));
        }
    } catch (err) {
        console.error('[ApprovalNotifier] Error:', err.message);
    }
}

// ── Command Handler: Process incoming WhatsApp commands ────────────────────────

async function handleCommand(text, sendFn) {
    const cmd = text.trim().toUpperCase();

    if (cmd.startsWith('APPROVE') || cmd.startsWith('YES') || cmd.startsWith('Y')) {
        const identifier = cmd.split(' ')[1] || cmd.split(' ')[0];
        await handleApproval(identifier, 'approved', sendFn);
    } else if (cmd.startsWith('REJECT') || cmd.startsWith('NO') || cmd.startsWith('N')) {
        const identifier = cmd.split(' ')[1] || cmd.split(' ')[0];
        await handleApproval(identifier, 'rejected', sendFn);
    } else if (cmd === 'STATUS' || cmd === 'STATUS ALL') {
        await showStatus(sendFn);
    } else if (cmd === 'HELP') {
        await showHelp(sendFn);
    } else if (cmd === 'AGENTS') {
        await showAgents(sendFn);
    } else if (cmd.startsWith('ISSUE') || cmd.startsWith('ISSUES')) {
        await showIssues(sendFn);
    } else if (cmd.startsWith('PAUSE')) {
        await pauseAgent(cmd.split(' ')[1], sendFn);
    } else if (cmd.startsWith('RESUME')) {
        await resumeAgent(cmd.split(' ')[1], sendFn);
    } else {
        await sendFn(ADMIN_NUMBER, `Unknown command: ${text}\n\n*Reply HELP for available commands.`);
    }
}

async function handleApproval(identifier, action, sendFn) {
    try {
        // Find issue by identifier or ID
        const issues = await paperclip.listIssues();
        const issue = issues.find(i =>
            i.identifier === identifier ||
            i.id === identifier ||
            i.identifier === identifier.toUpperCase()
        );

        if (!issue) {
            await sendFn(ADMIN_NUMBER, `❌ Issue "${identifier}" not found. Reply STATUS to see all issues.`);
            return;
        }

        const newStatus = action === 'approved' ? 'todo' : 'cancelled';

        await paperclip.updateIssue(issue.id, { status: newStatus });
        sentApprovals.delete(issue.id);

        if (action === 'approved') {
            await sendFn(ADMIN_NUMBER, `✅ *APPROVED:* ${issue.title}\n\nStatus set to: TODO\nAtlas will assign to the team.`);
        } else {
            await sendFn(ADMIN_NUMBER, `❌ *REJECTED:* ${issue.title}\n\nStatus set to: CANCELLED\nNo action will be taken.`);
        }
    } catch (err) {
        console.error('[Approval] Error:', err.message);
        await sendFn(ADMIN_NUMBER, `⚠️ Error processing approval: ${err.message}`);
    }
}

async function showStatus(sendFn) {
    try {
        const [issues, agents] = await Promise.all([
            paperclip.listIssues(),
            paperclip.listAgents(),
        ]);

        const byStatus = {};
        for (const i of issues) {
            byStatus[i.status] = (byStatus[i.status] || 0) + 1;
        }

        const agentMap = {};
        for (const a of agents) agentMap[a.id] = a.name;

        const active = agents.filter(a => a.status === 'running').map(a => a.name);
        const idle = agents.filter(a => a.status === 'idle').map(a => a.name);

        const msg = `📊 *CONCERTOS TEAM STATUS*

*Agents:*
🟢 Active: ${active.length > 0 ? active.join(', ') : 'None'}
⏳ Idle: ${idle.length > 0 ? idle.join(', ') : 'None'}

*Issues:*
${Object.entries(byStatus).map(([s, n]) => `  ${s}: ${n}`).join('\n')}

Total: ${issues.length} issues`;

        await sendFn(ADMIN_NUMBER, msg);
    } catch (err) {
        await sendFn(ADMIN_NUMBER, `⚠️ Error fetching status: ${err.message}`);
    }
}

async function showAgents(sendFn) {
    try {
        const agents = await paperclip.listAgents();
        const msg = `🤖 *CONCERTOS AGENTS*

${agents.map(a =>
            `${a.status === 'running' ? '🟢' : a.status === 'idle' ? '⏳' : '🔴'} *${a.name}* (${a.role})
   ${a.title}`
        ).join('\n\n')}`;

        await sendFn(ADMIN_NUMBER, msg);
    } catch (err) {
        await sendFn(ADMIN_NUMBER, `⚠️ Error: ${err.message}`);
    }
}

async function showIssues(sendFn) {
    try {
        const issues = await paperclip.listIssues({ status: 'backlog' });
        if (issues.length === 0) {
            await sendFn(ADMIN_NUMBER, '✅ All issues processed!');
            return;
        }

        const msg = `📋 *BACKLOG ISSUES* (${issues.length})

${issues.slice(0, 10).map(i =>
            `🔴 ${i.identifier} — ${i.title.slice(0, 60)}${i.title.length > 60 ? '...' : ''}
   Priority: ${i.priority}`
        ).join('\n\n')}${issues.length > 10 ? `\n\n...and ${issues.length - 10} more` : ''}

Reply APPROVE [identifier] or REJECT [identifier]`;

        await sendFn(ADMIN_NUMBER, msg);
    } catch (err) {
        await sendFn(ADMIN_NUMBER, `⚠️ Error: ${err.message}`);
    }
}

async function showHelp(sendFn) {
    const msg = `*CONCERTOS COMMAND CENTER*

*Approval:*
APPROVE [id] — Move issue to TODO
REJECT [id] — Cancel issue

*Status:*
STATUS — Team overview
AGENTS — List all agents
ISSUES — Backlog issues

*Control:*
PAUSE [agent] — Pause an agent
RESUME [agent] — Resume an agent

*Discovery:*
HELP — Show this menu

Example: APPROVE CON-32`;

    await sendFn(ADMIN_NUMBER, msg);
}

async function pauseAgent(name, sendFn) {
    try {
        const agents = await paperclip.listAgents();
        const agent = agents.find(a => a.name.toLowerCase() === name?.toLowerCase());
        if (!agent) {
            await sendFn(ADMIN_NUMBER, `Agent "${name}" not found. Reply AGENTS to see list.`);
            return;
        }
        await paperclip.pauseAgent(agent.id);
        await sendFn(ADMIN_NUMBER, `⏸️ ${agent.name} paused.`);
    } catch (err) {
        await sendFn(ADMIN_NUMBER, `⚠️ Error: ${err.message}`);
    }
}

async function resumeAgent(name, sendFn) {
    try {
        const agents = await paperclip.listAgents();
        const agent = agents.find(a => a.name.toLowerCase() === name?.toLowerCase());
        if (!agent) {
            await sendFn(ADMIN_NUMBER, `Agent "${name}" not found. Reply AGENTS to see list.`);
            return;
        }
        await paperclip.resumeAgent(agent.id);
        await sendFn(ADMIN_NUMBER, `▶️ ${agent.name} resumed.`);
    } catch (err) {
        await sendFn(ADMIN_NUMBER, `⚠️ Error: ${err.message}`);
    }
}

// ── Start polling ─────────────────────────────────────────────────────────────

let pollingInterval = null;

function startNotifier(sendFn) {
    if (pollingInterval) return;

    // Run immediately once
    checkPendingApprovals(sendFn).catch(console.error);

    // Then poll every 5 minutes
    pollingInterval = setInterval(() => {
        checkPendingApprovals(sendFn).catch(console.error);
    }, POLL_INTERVAL_MS);

    console.log(`[PaperclipApproval] Notifier started — polling every ${POLL_INTERVAL_MS / 60000}min`);
}

function stopNotifier() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
        console.log('[PaperclipApproval] Notifier stopped');
    }
}

module.exports = {
    startNotifier,
    stopNotifier,
    handleCommand,
    checkPendingApprovals,
};
