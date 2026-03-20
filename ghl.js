const axios = require('axios');

async function syncToGHL(lead) {
    const apiKey = process.env.GHL_API_KEY;
    const locationId = process.env.GHL_LOCATION_ID;

    if (!apiKey || !locationId) {
        console.log("GHL Sync skipped: Missing API Key or Location ID");
        return;
    }

    try {
        await axios.post('https://rest.gohighlevel.com/v1/contacts/', {
            name: lead.name,
            phone: lead.contact,
            tags: [lead.qualification, 'ConcertOS'],
            customFields: {
                inquiry: lead.inquiry
            }
        }, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        console.log("Lead synced to GHL successfully");
    } catch (err) {
        console.error("GHL Sync failed:", err.message);
    }
}

module.exports = { syncToGHL };
