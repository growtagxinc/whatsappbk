const Lead = require('./models/Lead');

async function handleReviewTrigger(leadId) {
    const lead = await Lead.findById(leadId);
    if (!lead || !lead.phone) return;

    // Fetch the business's review link (In production, this comes from the Business/User model)
    const reviewLink = process.env.GOOGLE_REVIEW_LINK || "https://g.page/r/your-shop/review";

    const reviewMessage = `Hi ${lead.name || 'there'}! It was a pleasure serving you. Could you take 30 seconds to leave us a review? It helps our small business a lot: ${reviewLink}`;

    // Ensure WhatsApp client is ready
    // Note: client is globally available in server.js
    return reviewMessage;
}

async function handleMissedCall(phone) {
    const recoveryMessage = `Hi! This is the AI assistant for Brand Pro. We just missed your call. How can we help you today? Please reply here and I can assist you 24/7.`;
    return recoveryMessage;
}

module.exports = { handleReviewTrigger, handleMissedCall };
