const axios = require('axios');

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERSION = 'v21.0'; // Latest as of late 2024/early 2025

/**
 * Send a message via Meta Cloud API
 * @param {string} to - Recipient phone number with country code
 * @param {string} text - Message text
 * @param {Object} [configOverrides] - Optional per-client credentials
 * @param {string} [configOverrides.metaToken] - Client's Meta token
 * @param {string} [configOverrides.metaPhoneNumberId] - Client's Meta Phone Number ID
 * @returns {Promise<Object>} - API response
 */
async function sendMessage(to, text, configOverrides = {}) {
    const token = configOverrides?.metaToken || WHATSAPP_TOKEN;
    const phoneId = configOverrides?.metaPhoneNumberId || PHONE_NUMBER_ID;

    if (!token || !phoneId) {
        throw new Error('Meta Cloud API credentials missing (neither in client config nor .env)');
    }

    try {
        const response = await axios({
            method: 'POST',
            url: `https://graph.facebook.com/${VERSION}/${phoneId}/messages`,
            data: {
                messaging_product: 'whatsapp',
                to: to,
                type: 'text',
                text: { body: text },
            },
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
        });
        return response.data;
    } catch (error) {
        console.error('❌ Meta API Error:', error.response ? error.response.data : error.message);
        throw error;
    }
}

module.exports = {
    sendMessage
};
    
