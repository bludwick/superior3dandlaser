'use strict';

const Stripe = require('stripe');

/**
 * API version that includes Checkout Session `branding_settings`
 * (Stripe changelog: 2025-09-30.clover). Without this, Stripe ignores/rejects branding params.
 * Override with env STRIPE_API_VERSION if needed.
 */
const STRIPE_API_VERSION = process.env.STRIPE_API_VERSION || '2025-09-30.clover';

function createStripeClient() {
  return new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
  });
}

module.exports = { createStripeClient, STRIPE_API_VERSION };
