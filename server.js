const { Client, LocalAuth, NoAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // More permissive for initial launch verification
        methods: ["GET", "POST"],
        credentials: true
    }
});

const mongoose = require('mongoose');
const Lead = require('./models/Lead');

const client = new Client({
    authStrategy: new NoAuth(),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

const port = process.env.PORT || 3000;

app.get('/health', (req, res) => {
    res.json({ 
        status: 'UP', 
        whatsapp: client.info ? 'CONNECTED' : 'DISCONNECTED',
        timestamp: new Date()
    });
});

// Connect to MongoDB
const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/concertos";
mongoose.connect(mongoUri)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.error('MongoDB Connection Error:', err));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const { qualifyLead } = require('./ai');
const { syncToGHL } = require('./ghl');

// Lead Ingestion (IndiaMart / Google)
app.post('/api/webhooks/leads', async (req, res) => {
    console.log('NEW LEAD RECEIVED:', req.body);
    const { contact, name, inquiry } = req.body;

    // AI Qualification
    const { qualification, reason, suggested_response } = await qualifyLead(inquiry);
    const aiResponse = suggested_response || `Hi ${name || 'there'}! This is the AI assistant for Brand Pro. We received your inquiry regarding "${inquiry}". One of our specialists will call you shortly.`;

    // 1. Store/Update in Internal CRM (MongoDB)
    try {
        const lead = await Lead.findOneAndUpdate(
            { phone: contact },
            { 
                name, inquiry, qualification, reason, 
                $push: { conversation: { role: 'ai', content: aiResponse } } 
            },
            { upsert: true, new: true }
        );

        // 2. Process and Send WhatsApp
        if (contact && client.info) {
            const chatId = contact.includes('@c.us') ? contact : `${contact.replace('+', '')}@c.us`;
            await client.sendMessage(chatId, aiResponse);
            io.emit('lead', lead);
        }
    } catch (err) {
        console.error('CRM Update failed:', err);
    }

    res.status(200).json({ success: true, message: 'Lead processed' });
});

// Internal CRM Endpoints
app.get('/api/leads', async (req, res) => {
    try {
        const leads = await Lead.find().sort({ updatedAt: -1 });
        res.json(leads);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const { handleReviewTrigger } = require('./automation');

app.patch('/api/leads/:id', async (req, res) => {
    try {
        const lead = await Lead.findByIdAndUpdate(req.params.id, req.body, { new: true });
        
        // Auto-Review Trigger
        if (req.body.status === 'PAID') {
            const reviewMsg = await handleReviewTrigger(lead._id);
            if (client.info && lead.phone) {
                const chatId = lead.phone.includes('@c.us') ? lead.phone : `${lead.phone.replace('+', '')}@c.us`;
                await client.sendMessage(chatId, reviewMsg);
            }
        }
        res.json(lead);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('QR Generation failed:', err);
            return;
        }
        io.emit('qr', url);
    });
});

client.on('ready', () => {
    console.log('Client is ready!');
    io.emit('ready', 'WhatsApp is connected');
});

client.on('authenticated', () => {
    console.log('Authenticated');
    io.emit('authenticated', 'Authenticated');
});

client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
    io.emit('error', 'Auth failure: ' + msg);
});

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
    io.emit('disconnected', 'Disconnected');
    // Removed client.initialize() here to prevent recursive crashes on boot
});

// Simple message handler
client.on('message', async msg => {
    if (msg.body === '!ping') {
        msg.reply('pong');
    }
});

io.on('connection', (socket) => {
    console.log('New client connected');
    socket.emit('status', 'Connecting to WhatsApp...');

    socket.on('request_pairing_code', async (phoneNumber) => {
        console.log(`PAIRING CODE REQUESTED FOR: ${phoneNumber}`);
        try {
            // Ensure phone number is in correct format (digits only)
            const cleanPhone = phoneNumber.replace(/\D/g, '');
            const code = await client.requestPairingCode(cleanPhone);
            socket.emit('pairing_code', code);
            console.log(`PAIRING CODE GENERATED: ${code}`);
        } catch (err) {
            console.error('Pairing code generation failed:', err);
            socket.emit('error', 'Failed to generate pairing code. Please try again.');
        }
    });

    socket.on('reset_qr', async () => {
        console.log('RESETTING WHATSAPP...');
        try {
            await client.destroy();
            await client.initialize();
        } catch (err) {
            console.error('Reset failed:', err);
        }
    });
});

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

client.initialize();
