exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Return null taxAmount when Stripe is not configured — frontend falls back to static rate
  if (!process.env.STRIPE_SECRET_KEY) {
    return jsonResponse(200, { taxAmount: null });
  }

  let state, zip, lineItems;
  try {
    ({ state, zip, lineItems } = JSON.parse(event.body || '{}'));
  } catch {
    return jsonResponse(400, { error: 'Invalid request body' });
  }

  if (!state || !zip || !Array.isArray(lineItems) || lineItems.length === 0) {
    return jsonResponse(200, { taxAmount: null });
  }

  try {
    const { createStripeClient } = require('./stripe-client');
    const stripe = createStripeClient();

    const calculation = await stripe.tax.calculations.create({
      currency: 'usd',
      customer_details: {
        address: {
          state,
          postal_code: zip,
          country: 'US',
        },
        address_source: 'shipping',
      },
      line_items: lineItems.map(item => ({
        amount:       Math.round((item.unitPrice || 0) * (item.qty || 1) * 100),
        reference:    item.partName || item.fileName || 'Print Job Part',
        tax_behavior: 'exclusive',
      })),
    });

    const taxAmountCents = calculation.tax_amount_exclusive;
    const totalAmountCents = calculation.amount_total;
    const subtotalCents = totalAmountCents - taxAmountCents;
    const effectiveRate = subtotalCents > 0 ? taxAmountCents / subtotalCents : 0;

    // Build a readable jurisdiction label, e.g. "TX Sales Tax (8.25%)"
    let jurisdiction = state;
    if (calculation.tax_breakdown && calculation.tax_breakdown.length > 0) {
      const top = calculation.tax_breakdown[0];
      if (top.jurisdiction && top.jurisdiction.display_name) {
        jurisdiction = top.jurisdiction.display_name;
      }
    }
    const rateDisplay = (effectiveRate * 100).toFixed(2).replace(/\.?0+$/, '');
    const label = `${jurisdiction} Sales Tax (${rateDisplay}%)`;

    return jsonResponse(200, {
      taxAmount:     taxAmountCents / 100,
      taxRate:       effectiveRate,
      label,
      calculationId: calculation.id,
    });
  } catch (err) {
    console.error('[calculate-tax] Stripe error:', err.message);
    // Return null so frontend falls back gracefully
    return jsonResponse(200, { taxAmount: null });
  }
};

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
