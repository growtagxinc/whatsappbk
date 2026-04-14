const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { z } = require('zod');
const Ticket = require('../../models/Ticket');
const { authMiddleware } = require('../lib/auth');
const { validate } = require('../lib/validate-middleware');

// ── Zod Schemas for Ticket routes ─────────────────────────────────────────
const CreateTicketSchema = z.object({
    title: z.string().min(1, 'Title is required').max(200),
    description: z.string().optional(),
    chatId: z.string().max(100).optional(),
    customerName: z.string().max(200).optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    tags: z.array(z.string()).optional(),
});

const UpdateTicketSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().optional(),
    status: z.enum(['open', 'in_progress', 'resolved']).optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    assignedTo: z.string().max(100).optional(),
    tags: z.array(z.string()).optional(),
});

// All ticket routes require authentication
router.use(authMiddleware);

/**
 * GET /api/tickets
 * List tickets for the workspace.
 * Supports ?status=open,in_progress&priority=high,urgent&search=query
 */
router.get('/', async (req, res) => {
    try {
        const { workspaceId } = req;
        if (!workspaceId) return res.status(401).json({ error: 'No workspace' });

        const filter = { clientId: workspaceId };

        if (req.query.status) {
            filter.status = { $in: req.query.status.split(',') };
        }
        if (req.query.priority) {
            filter.priority = { $in: req.query.priority.split(',') };
        }

        let query = Ticket.find(filter).sort({ createdAt: -1 });

        const total = await Ticket.countDocuments(filter);
        const tickets = await query.exec();

        res.json({ tickets, total });
    } catch (err) {
        console.error('[GET tickets]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/tickets
 * Create a new ticket.
 * Body: { title, description?, chatId?, customerName?, priority?, tags? }
 */
router.post('/', validate(CreateTicketSchema), async (req, res) => {
    try {
        const { workspaceId, userId } = req;
        if (!workspaceId) return res.status(401).json({ error: 'No workspace' });

        const { title, description, chatId, customerName, priority, tags } = req.validatedBody;

        const ticketId = `TKT-${crypto.randomInt(10000, 99999)}`;

        const ticket = await Ticket.create({
            ticketId,
            clientId: workspaceId,
            chatId: chatId || null,
            customerName: customerName || 'Unknown',
            title: title.trim(),
            description: description || '',
            status: 'open',
            priority: priority || 'medium',
            tags: tags || [],
            messages: [{
                id: crypto.randomBytes(4).toString('hex'),
                author: userId,
                authorType: 'agent',
                content: description || '',
            }]
        });

        // Broadcast to Socket.io clients
        const io = req.app.get('io');
        if (io) {
            io.to(`workspace:${workspaceId}`).emit('ticket:created', { ticket });
        }

        res.status(201).json({ ticket });
    } catch (err) {
        console.error('[POST tickets]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/tickets/:ticketId
 * Get a single ticket with messages.
 */
router.get('/:ticketId', async (req, res) => {
    try {
        const { workspaceId } = req;
        const ticket = await Ticket.findOne({
            ticketId: req.params.ticketId,
            clientId: workspaceId
        });

        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
        res.json({ ticket });
    } catch (err) {
        console.error('[GET ticket]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * PATCH /api/tickets/:ticketId
 * Update ticket fields: status, priority, assignedTo, assigneeName, title, tags.
 */
router.patch('/:ticketId', validate(UpdateTicketSchema), async (req, res) => {
    try {
        const { workspaceId, userId } = req;
        const { title, description, status, priority, assignedTo, tags } = req.validatedBody;

        // Build update object from validated fields
        const updates = {};
        if (title !== undefined) updates.title = title;
        if (description !== undefined) updates.description = description;
        if (status !== undefined) updates.status = status;
        if (priority !== undefined) updates.priority = priority;
        if (assignedTo !== undefined) updates.assignedTo = assignedTo;
        if (tags !== undefined) updates.tags = tags;

        const ticket = await Ticket.findOneAndUpdate(
            { ticketId: req.params.ticketId, clientId: workspaceId },
            { $set: updates },
            { new: true }
        );

        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        // Broadcast update
        const io = req.app.get('io');
        if (io) {
            io.to(`workspace:${workspaceId}`).emit('ticket:updated', { ticket });
        }

        res.json({ ticket });
    } catch (err) {
        console.error('[PATCH ticket]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/tickets/:ticketId/messages
 * Add a message to a ticket thread.
 * Body: { content, authorType? }
 */
router.post('/:ticketId/messages', async (req, res) => {
    try {
        const { workspaceId, userId } = req;
        const { content, authorType } = req.body;
        if (!content?.trim()) return res.status(400).json({ error: 'Content is required' });

        const ticket = await Ticket.findOneAndUpdate(
            { ticketId: req.params.ticketId, clientId: workspaceId },
            {
                $push: {
                    messages: {
                        id: crypto.randomBytes(4).toString('hex'),
                        author: userId,
                        authorType: authorType || 'agent',
                        content: content.trim(),
                        createdAt: new Date()
                    }
                }
            },
            { new: true }
        );

        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        const newMsg = ticket.messages[ticket.messages.length - 1];

        // Broadcast new message
        const io = req.app.get('io');
        if (io) {
            io.to(`workspace:${workspaceId}`).emit('ticket:message', {
                ticketId: req.params.ticketId,
                message: newMsg
            });
        }

        res.status(201).json({ message: newMsg });
    } catch (err) {
        console.error('[POST ticket message]', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;