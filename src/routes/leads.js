const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { z } = require('zod');
const { authMiddleware } = require('../lib/auth');
const { validate } = require('../lib/validate-middleware');

// ── Lead Schema (stored in MongoDB) ────────────────────────────────────────────
const leadSchema = new mongoose.Schema({
  clientId:    { type: String, required: true, index: true },
  orgId:       { type: String, required: true, index: true },
  workspaceId: { type: String, required: true, index: true },
  name:        { type: String, required: true },
  email:       { type: String, default: '' },
  phone:       { type: String, default: '' },
  source:      { type: String, default: 'WhatsApp' },
  status:      { type: String, enum: ['new','contacted','qualified','proposal','won','lost'], default: 'new' },
  value:       { type: String, default: '' },
  notes:       { type: String, default: '' },
  assignee:    { type: String, default: '' },
}, { timestamps: true });

const Lead = mongoose.models.Lead || mongoose.model('Lead', leadSchema);

// ── Zod Schemas for Lead routes ───────────────────────────────────────────────
const phoneRegex = /^\+91[6-9]\d{9}$/;

const CreateLeadSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  phone: z.string().regex(phoneRegex, 'Invalid phone format').optional().or(z.literal('')),
  source: z.string().max(100).optional(),
  status: z.enum(['new','contacted','qualified','proposal','won','lost']).optional(),
  value: z.string().max(50).optional(),
  notes: z.string().optional(),
  assignee: z.string().max(100).optional(),
});

const UpdateLeadSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  phone: z.string().regex(phoneRegex).optional().or(z.literal('')),
  source: z.string().max(100).optional(),
  status: z.enum(['new','contacted','qualified','proposal','won','lost']).optional(),
  value: z.string().max(50).optional(),
  notes: z.string().optional(),
  assignee: z.string().max(100).optional(),
});

// ── GET /api/leads ─────────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const leads = await Lead.find({
      workspaceId: req.workspaceId,
    }).sort({ createdAt: -1 }).lean();

    res.json({ leads });
  } catch (err) {
    console.error('[Leads] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// ── POST /api/leads ────────────────────────────────────────────────────────────
router.post('/', authMiddleware, validate(CreateLeadSchema), async (req, res) => {
  try {
    const { name, email, phone, source, status, value, notes, assignee } = req.validatedBody;

    const lead = await new Lead({
      clientId: req.userId,
      orgId: req.orgId,
      workspaceId: req.workspaceId,
      name: name.trim(),
      email: email || '',
      phone: phone || '',
      source: source || 'WhatsApp',
      status: status || 'new',
      value: value || '',
      notes: notes || '',
    }).save();

    // Emit real-time event via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.to(req.workspaceId).emit('lead_created', lead.toObject ? lead.toObject() : lead);
    }

    res.status(201).json({ lead });
  } catch (err) {
    console.error('[Leads] POST error:', err);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

// ── PATCH /api/leads/:id ───────────────────────────────────────────────────────
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, email, phone, source, status, value, notes, assignee } = req.body;
    const update = {};
    if (name !== undefined)    update.name = name.trim();
    if (email !== undefined)   update.email = email;
    if (phone !== undefined)   update.phone = phone;
    if (source !== undefined)  update.source = source;
    if (status !== undefined) update.status = status;
    if (value !== undefined)  update.value = value;
    if (notes !== undefined)  update.notes = notes;
    if (assignee !== undefined) update.assignee = assignee;

    const lead = await Lead.findOneAndUpdate(
      { _id: req.params.id, workspaceId: req.workspaceId },
      { $set: update },
      { new: true }
    ).lean();

    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const io = req.app.get('io');
    if (io) {
      io.to(req.workspaceId).emit('lead_updated', lead);
    }

    res.json({ lead });
  } catch (err) {
    console.error('[Leads] PATCH error:', err);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

// ── DELETE /api/leads/:id ──────────────────────────────────────────────────────
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const lead = await Lead.findOneAndDelete({
      _id: req.params.id,
      workspaceId: req.workspaceId,
    });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const io = req.app.get('io');
    if (io) {
      io.to(req.workspaceId).emit('lead_deleted', { leadId: req.params.id });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Leads] DELETE error:', err);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

module.exports = router;
