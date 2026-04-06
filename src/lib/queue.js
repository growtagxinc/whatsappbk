const { Queue } = require('bullmq');
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const url = new URL(REDIS_URL);
const connection = {
    host: url.hostname,
    port: parseInt(url.port) || 6379,
    maxRetriesPerRequest: null
};

// Throttled error logging — only log once per 60 seconds per source
const _lastLogTime = {};
function throttledWarn(source, msg) {
    const now = Date.now();
    if (!_lastLogTime[source] || now - _lastLogTime[source] > 60000) {
        _lastLogTime[source] = now;
        console.warn(`⚠️ ${source}: ${msg} (throttled — next log in 60s)`);
    }
}

// Track whether Redis is available
let redisAvailable = false;

// Define Queues with retry handling
let inboundQueue, outboundQueue;

// Ping Redis FIRST before creating any queues
(async () => {
    try {
        const testClient = new Redis({
            host: url.hostname,
            port: parseInt(url.port) || 6379,
            connectTimeout: 2000,
            maxRetriesPerRequest: 1,
            retryStrategy: () => null  // Don't retry — fail fast
        });
        
        await testClient.ping();
        testClient.disconnect();
        redisAvailable = true;
        
        // Redis is alive — safe to create queues
        inboundQueue = new Queue('inbound-messages', { connection });
        outboundQueue = new Queue('outbound-messages', { connection });
        
        inboundQueue.on('error', err => throttledWarn("BullMQ Inbound Queue", err.message));
        outboundQueue.on('error', err => throttledWarn("BullMQ Outbound Queue", err.message));
        
        console.log("✅ BullMQ Queues initialized (Redis connected)");
    } catch (err) {
        console.warn("⚠️ Redis unreachable. BullMQ queues disabled. Server will operate without queues.");
        redisAvailable = false;
    }
})();

async function pushInbound(data) {
    if (!inboundQueue) return;
    await inboundQueue.add('process-inbound', data, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }
    });
}

async function pushOutbound(data) {
    if (!outboundQueue) return;
    await outboundQueue.add('send-whatsapp', data, {
        attempts: 5,
        backoff: { type: 'fixed', delay: 2000 }
    });
}

module.exports = {
    pushInbound,
    pushOutbound,
    connection,
    throttledWarn,
    isRedisAvailable: () => redisAvailable
};

