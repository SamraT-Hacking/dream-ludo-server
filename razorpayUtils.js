
// dream-ludo-server/razorpayUtils.js

"use strict";

const crypto = require('crypto');

class RazorpayUtils {
    /**
     * Creates a Payment Link via Razorpay API
     * @param {Object} params - Payment link parameters
     * @param {string} keyId - Razorpay Key ID
     * @param {string} keySecret - Razorpay Key Secret
     */
    static async createPaymentLink(params, keyId, keySecret) {
        const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
        
        try {
            const response = await fetch('https://api.razorpay.com/v1/payment_links', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${auth}`
                },
                body: JSON.stringify(params)
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                console.error("Razorpay API Error:", data);
                throw new Error(data.error ? data.error.description : 'Failed to create Razorpay link');
            }
            
            return data;
        } catch (error) {
            console.error("Razorpay Create Link Exception:", error);
            throw error;
        }
    }

    /**
     * Verifies the signature returned by Razorpay in the callback
     * @param {Object} params - Query parameters from the callback
     * @param {string} keySecret - Razorpay Key Secret
     */
    static verifySignature(params, keySecret) {
        const {
            razorpay_payment_link_id,
            razorpay_payment_link_reference_id,
            razorpay_payment_link_status,
            razorpay_payment_id,
            razorpay_signature
        } = params;

        if (!razorpay_payment_link_id || !razorpay_payment_link_reference_id || !razorpay_payment_link_status || !razorpay_payment_id || !razorpay_signature) {
            return false;
        }

        const payload = `${razorpay_payment_link_id}|${razorpay_payment_link_reference_id}|${razorpay_payment_link_status}|${razorpay_payment_id}`;
        
        const generatedSignature = crypto
            .createHmac('sha256', keySecret)
            .update(payload)
            .digest('hex');

        return generatedSignature === razorpay_signature;
    }
}

module.exports = RazorpayUtils;
